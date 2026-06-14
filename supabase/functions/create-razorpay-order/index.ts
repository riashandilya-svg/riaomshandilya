import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { items } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "No items" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── SERVER-SIDE PRICES (source of truth) ──
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

    let subtotal = 0;
    const verified = [];
    for (const item of items) {
      const price = PRICES[item.id];
      if (!price) {
        return new Response(JSON.stringify({ error: `Unknown product: ${item.id}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const qty = Math.max(1, Math.min(10, parseInt(item.qty) || 1));
      subtotal += price * qty;
      verified.push({ id: item.id, title: item.title, qty, price });
    }

    const total = subtotal + SHIPPING;

    // ── Create Razorpay Order ──
    const rzpKey = Deno.env.get("RAZORPAY_KEY_ID")!;
    const rzpSecret = Deno.env.get("RAZORPAY_KEY_SECRET")!;

    // Razorpay notes values have a 256 char limit per value
    const itemsSummary = verified.map(v => `${v.id}:${v.qty}`).join(",");
    const notesObj: Record<string, string> = {
      subtotal: String(subtotal),
      shipping: String(SHIPPING),
    };
    if (itemsSummary.length <= 256) {
      notesObj.items_compact = itemsSummary;
    }

    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + btoa(`${rzpKey}:${rzpSecret}`),
      },
      body: JSON.stringify({
        amount: total * 100,
        currency: "INR",
        receipt: `order_${Date.now()}`,
        notes: notesObj,
      }),
    });

    if (!rzpRes.ok) {
      const err = await rzpRes.text();
      return new Response(JSON.stringify({ error: "Razorpay error", detail: err }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rzpOrder = await rzpRes.json();

    return new Response(JSON.stringify({
      order_id: rzpOrder.id,
      amount: total * 100,
      subtotal,
      shipping: SHIPPING,
      verified_items: verified,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
