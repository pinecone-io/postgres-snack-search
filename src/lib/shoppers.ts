// The shop's regulars. Kept in their own module, separate from the code that
// turns a persona into a query (shopperBrain.ts), because the `/shop` UI
// needs this list in the browser to lay out one panel per shopper — and
// shopperBrain.ts imports `@/lib/env`, which validates server-only secrets
// and throws where they don't exist. A plain data list has no such
// requirement, so it lives here and both sides import it.
export interface Shopper {
  id: string;
  templatedQuery: string;
  persona: string;
}

export const SHOPPERS: Shopper[] = [
  { id: "alex", templatedQuery: "something spicy and crunchy", persona: "loves heat and crunch, always in a hurry" },
  { id: "bea", templatedQuery: "a sweet treat for movie night", persona: "planning a cozy movie night with friends" },
  { id: "cal", templatedQuery: "a salty snack to share", persona: "hosting game night, wants something to share" },
  { id: "dee", templatedQuery: "something chocolatey", persona: "having a rough day, wants chocolate" },
  { id: "eli", templatedQuery: "a crispy road trip snack", persona: "packing snacks for a long road trip" },
  { id: "fay", templatedQuery: "a light, healthy-ish snack", persona: "trying to eat a bit lighter this week" },
];
