import { CLAUDE_MODELS, creditsPerMillion, type ModelEntry, type PriceTier } from "@unspent/shared";

// Prices in credits per 1M tokens, straight from models.ts with the markup applied (brief 5.2, 11.5).

function rowsOf(m: ModelEntry): { name: string; tier: PriceTier }[] {
  if (m.tiers.length === 1) return [{ name: m.displayName, tier: m.tiers[0]! }];
  return m.tiers.map((tier, i) => {
    const prev = m.tiers[i - 1]?.maxPromptTokens;
    const limit = tier.maxPromptTokens ?? prev ?? 0;
    const k = `${Math.round(limit / 1000)}k`;
    return {
      name: `${m.displayName}, prompts ${tier.maxPromptTokens === null ? `over ${k}` : `up to ${k}`}`,
      tier,
    };
  });
}

export function PricingTable() {
  const rows = CLAUDE_MODELS.filter((m) => m.enabled).flatMap(rowsOf);
  const p = (v: bigint) => creditsPerMillion(v);
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Prices in credits per 1M tokens</caption>
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cache write 5m</th>
            <th className="num">Cache write 1h</th>
            <th className="num">Cache read</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, tier }) => (
            <tr key={name}>
              <td className="whitespace-nowrap">{name}</td>
              <td className="num">{p(tier.prices.input)}</td>
              <td className="num">{p(tier.prices.output)}</td>
              <td className="num">{p(tier.prices.cacheWrite5m)}</td>
              <td className="num">{p(tier.prices.cacheWrite1h)}</td>
              <td className="num">{p(tier.prices.cacheRead)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
