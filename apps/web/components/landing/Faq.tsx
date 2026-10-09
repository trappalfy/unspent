// FAQ (brief 11.5), final texts. Answers are long-form: --sans.

const ITEMS: [string, string][] = [
  [
    "Do credits expire?",
    "No. A credit is a token in your wallet. It stays there until you spend it, send it, or sell it.",
  ],
  [
    "Can I get USDC back from Unspent?",
    "Not while the service runs: credits are sold for inference. To exit, sell them on a DEX or send them to someone who needs inference. If Unspent shuts down, every credit becomes redeemable for 1 USDC from the reserve.",
  ],
  [
    "Which models can I use?",
    "Claude models. The current list and prices are on this page and at /v1/models.",
  ],
  [
    "Is every request onchain?",
    "Yes. Each request reserves its maximum cost in the program before the model runs and settles the metered cost after. Both transactions are public on Solana.",
  ],
  [
    "Do you store my prompts?",
    "No. We keep request metadata for billing: time, model, token counts and cost. Prompts and responses pass through and are not stored. The amount and time of each request are public onchain.",
  ],
  [
    "What does a request cost?",
    "Tokens times the model's price. A Sonnet 5.5 request with 2,000 input tokens and 500 output tokens costs 0.01035 credits.",
  ],
  [
    "What do I need to start?",
    "A Solana wallet with USDC or any token you can swap, and a little SOL for network fees.",
  ],
];

export function Faq() {
  return (
    <div className="border-t border-line">
      {ITEMS.map(([q, a]) => (
        <details key={q} className="faq border-b border-line">
          <summary className="flex cursor-pointer items-center justify-between gap-4 py-4 text-base">
            {q}
          </summary>
          <p className="max-w-[65ch] pb-5 font-sans text-base text-mute">{a}</p>
        </details>
      ))}
    </div>
  );
}
