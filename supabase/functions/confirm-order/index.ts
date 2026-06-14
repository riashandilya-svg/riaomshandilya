import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRICES: Record<string, number> = {
  "soulful-bollywood": 499,
  "peppy-bollywood": 499,
  "romantic-bollywood": 499,
  "classic-bollywood": 499,
  "meet-notes-beginner": 399,
  "meet-notes-theory": 399,
  "wyom-100": 299,
  "wyom-72": 249,
  "track-your-journey": 299,
  "combo-classic-romantic": 1200,
  "combo-classic-romantic-peppy": 1700,
  "combo-all-four": 2200,
};
const SHIPPING = 0;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      name,
      email,
      phone,
      address,
    } = await req.json();

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing payment details" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: Verify Razorpay signature
    const razorpaySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!razorpaySecret) {
      return new Response(
        JSON.stringify({ success: false, error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const expectedSignature = createHmac("sha256", razorpaySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return new Response(
        JSON.stringify({ success: false, error: "Payment verification failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: Fetch the Razorpay order to get server-verified amount and items
    const razorpayKeyId = Deno.env.get("RAZORPAY_KEY_ID");
    const orderRes = await fetch(
      `https://api.razorpay.com/v1/orders/${razorpay_order_id}`,
      {
        headers: {
          Authorization: "Basic " + btoa(`${razorpayKeyId}:${razorpaySecret}`),
        },
      }
    );

    if (!orderRes.ok) {
      return new Response(
        JSON.stringify({ success: false, error: "Could not verify order with Razorpay" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const razorpayOrder = await orderRes.json();

    if (razorpayOrder.status !== "paid") {
      return new Response(
        JSON.stringify({ success: false, error: "Order not yet paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const totalPaise = razorpayOrder.amount;
    const notes = razorpayOrder.notes || {};

    // Step 3: Resolve items from notes (compact format: "id:qty,id:qty")
    let orderItems: any[] = [];
    let subtotal = notes.subtotal ? parseInt(notes.subtotal) : Math.floor(totalPaise / 100);

    if (notes.items_compact) {
      const pairs = notes.items_compact.split(",");
      for (const pair of pairs) {
        const [id, qtyStr] = pair.split(":");
        const qty = parseInt(qtyStr) || 1;
        const price = PRICES[id];
        if (price) {
          orderItems.push({ id, title: id, qty, price });
        }
      }
    }

    // Verify: subtotal from notes must match what Razorpay charged
    const shippingAmount = notes.shipping ? parseInt(notes.shipping) : SHIPPING;
    const expectedTotal = subtotal + shippingAmount;
    if (expectedTotal * 100 !== totalPaise) {
      return new Response(
        JSON.stringify({ success: false, error: "Amount mismatch" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 4: Insert order into Supabase using service_role key
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, supabaseServiceKey);

    const addressStr = address
      ? `${address.line1 || ""}${address.line2 ? ", " + address.line2 : ""}`
      : "";

    const { data, error } = await db.from("orders").insert([{
      razorpay_payment_id,
      razorpay_order_id,
      name: (name || "").slice(0, 200),
      email: (email || "").slice(0, 200),
      phone: (phone || "").slice(0, 20),
      address: addressStr.slice(0, 500),
      city: (address?.city || "").slice(0, 100),
      state: (address?.state || "").slice(0, 100),
      pin: (address?.pin || "").slice(0, 10),
      country: (address?.country || "India").slice(0, 50),
      items: orderItems,
      subtotal,
      shipping: shippingAmount,
      total: Math.floor(totalPaise / 100),
      status: "paid",
    }]).select("id").single();

    if (error) {
      console.error("DB insert error:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to save order" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 5: Send confirmation email
    const shortId = data.id.toString().slice(0, 8).toUpperCase();
    try {
      await fetch(`${supabaseUrl}/functions/v1/send-order-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          name,
          email,
          orderId: shortId,
          items: orderItems,
          total: `₹${Math.floor(totalPaise / 100)}`,
          address: `${addressStr}, ${address?.city}, ${address?.state} - ${address?.pin}`,
        }),
      });
    } catch (emailErr) {
      console.warn("Email send failed:", emailErr);
    }

    return new Response(
      JSON.stringify({ success: true, order_id: data.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
