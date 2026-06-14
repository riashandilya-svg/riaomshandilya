import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Step 3: Insert order into Supabase using service_role key
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, supabaseServiceKey);

    const addressStr = address
      ? `${address.line1}${address.line2 ? ", " + address.line2 : ""}`
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
      items: notes.items ? JSON.parse(notes.items) : [],
      subtotal: notes.subtotal ? parseInt(notes.subtotal) : Math.floor(totalPaise / 100),
      shipping: notes.shipping ? parseInt(notes.shipping) : 0,
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

    // Step 4: Send confirmation email
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
          items: notes.items ? JSON.parse(notes.items) : [],
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
