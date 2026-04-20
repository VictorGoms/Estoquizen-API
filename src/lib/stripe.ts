import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-03-25.dahlia",
});

export const PRICE_IDS: Record<string, string> = {
  basic:  process.env.STRIPE_PRICE_BASIC  ?? "",
  growth: process.env.STRIPE_PRICE_GROWTH ?? "",
  pro:    process.env.STRIPE_PRICE_PRO    ?? "",
};
