// parseProgramEvents: invoke-stack attribution and JSON-safe decoding of every event type.

import { type Address, address, type ReadonlyUint8Array } from "@solana/kit";
import {
  ConfigField,
  eventOwner,
  getBackupGatewayActivatedEventEncoder,
  getChangeAppliedEventEncoder,
  getChangeCancelledEventEncoder,
  getChangeProposedEventEncoder,
  getCreditsBoughtEventEncoder,
  getDepositedEventEncoder,
  getExpiredEventEncoder,
  getGatewayRevokedEventEncoder,
  getLimitChangedEventEncoder,
  getPauseSetEventEncoder,
  getRedeemedEventEncoder,
  getReserveCapSetEventEncoder,
  getReservedEventEncoder,
  getSettledEventEncoder,
  getShutDownEventEncoder,
  getSurplusSweptEventEncoder,
  getWithdrawnEventEncoder,
  PauseTarget,
  PROGRAM_EVENT_NAMES,
  parseProgramEvents,
} from "@unspent/program";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, data, hexOf, invocation, JUPITER, ours, PROGRAM, requestId, TOKEN } from "./logs";

const alice = address(ALICE);
const bob = address(BOB);
const rid = requestId(7);

const settled = getSettledEventEncoder().encode({
  owner: alice,
  requestId: rid,
  reserved: 2_000_000n,
  actual: 10_350n,
});
const deposited = getDepositedEventEncoder().encode({ owner: alice, amount: 5n });

// Every event: encoded payload and the JSON the parser must produce.
const ALL: [string, ReadonlyUint8Array, Record<string, string | boolean>][] = [
  [
    "CreditsBought",
    getCreditsBoughtEventEncoder().encode({ buyer: alice, amount: 100_000_000n }),
    { buyer: ALICE, amount: "100000000" },
  ],
  [
    "Deposited",
    getDepositedEventEncoder().encode({ owner: alice, amount: 60_000_000n }),
    { owner: ALICE, amount: "60000000" },
  ],
  [
    "Withdrawn",
    getWithdrawnEventEncoder().encode({ owner: alice, amount: 18_446_744_073_709_551_615n }),
    { owner: ALICE, amount: "18446744073709551615" },
  ],
  [
    "ReserveCapSet",
    getReserveCapSetEventEncoder().encode({ owner: alice, cap: 0n }),
    { owner: ALICE, cap: "0" },
  ],
  [
    "Reserved",
    getReservedEventEncoder().encode({
      owner: alice,
      requestId: rid,
      amount: 2_000_000n,
      expiresAt: 1_791_566_150n,
    }),
    { owner: ALICE, requestId: hexOf(rid), amount: "2000000", expiresAt: "1791566150" },
  ],
  ["Settled", settled, { owner: ALICE, requestId: hexOf(rid), reserved: "2000000", actual: "10350" }],
  [
    "Expired",
    getExpiredEventEncoder().encode({ owner: alice, requestId: rid, amount: 1n }),
    { owner: ALICE, requestId: hexOf(rid), amount: "1" },
  ],
  [
    "Redeemed",
    getRedeemedEventEncoder().encode({ owner: bob, amount: 40_000_000n }),
    { owner: BOB, amount: "40000000" },
  ],
  ["ShutDown", getShutDownEventEncoder().encode({}), {}],
  [
    "SurplusSwept",
    getSurplusSweptEventEncoder().encode({ usdc: 3n, credits: 4n }),
    { usdc: "3", credits: "4" },
  ],
  [
    "LimitChanged",
    getLimitChangedEventEncoder().encode({ field: ConfigField.SupplyCap, value: 9n }),
    { field: "SupplyCap", value: "9" },
  ],
  [
    "PauseSet",
    getPauseSetEventEncoder().encode({ target: PauseTarget.Gateway, paused: true }),
    { target: "Gateway", paused: true },
  ],
  [
    "ChangeProposed",
    getChangeProposedEventEncoder().encode({
      field: ConfigField.Treasury,
      value: 0n,
      key: bob,
      effectiveAt: -5n,
    }),
    { field: "Treasury", value: "0", key: BOB, effectiveAt: "-5" },
  ],
  [
    "ChangeApplied",
    getChangeAppliedEventEncoder().encode({ field: ConfigField.GatewayBackup, value: 0n, key: bob }),
    { field: "GatewayBackup", value: "0", key: BOB },
  ],
  [
    "ChangeCancelled",
    getChangeCancelledEventEncoder().encode({ field: ConfigField.MaxBuyPerIx }),
    { field: "MaxBuyPerIx" },
  ],
  ["GatewayRevoked", getGatewayRevokedEventEncoder().encode({}), {}],
  [
    "BackupGatewayActivated",
    getBackupGatewayActivatedEventEncoder().encode({ gateway: bob }),
    { gateway: BOB },
  ],
];

describe("parseProgramEvents", () => {
  it("round-trips every event type", () => {
    expect(new Set(ALL.map(([n]) => n))).toEqual(new Set(PROGRAM_EVENT_NAMES));
    expect(PROGRAM_EVENT_NAMES).toHaveLength(17);
    for (const [name, bytes, json] of ALL) {
      expect(parseProgramEvents(ours(bytes))).toEqual([{ name, data: json }]);
    }
  });

  it("keeps multiple events of one transaction in emission order", () => {
    const logs = [...ours(deposited), ...ours(settled, settled), ...ours(ALL[0]![1])];
    expect(parseProgramEvents(logs).map((e) => e.name)).toEqual([
      "Deposited",
      "Settled",
      "Settled",
      "CreditsBought",
    ]);
  });

  it("ignores Program data from other programs, also nested inside ours", () => {
    const logs = [
      // a swap logging an event with OUR discriminator before calling anything
      ...invocation(JUPITER, 1, [data(settled), ...invocation(TOKEN, 2, [data(settled)])]),
      // our instruction calls the token program, which logs data; ours resumes after the CPI returns
      ...invocation(PROGRAM, 1, [
        data(deposited),
        ...invocation(TOKEN, 2, ["Program log: Instruction: Burn", data(settled)]),
        data(settled),
      ]),
    ];
    expect(parseProgramEvents(logs).map((e) => e.name)).toEqual(["Deposited", "Settled"]);
  });

  it("captures our events when another program invokes us by CPI", () => {
    const logs = invocation(JUPITER, 1, [
      data(deposited),
      ...invocation(PROGRAM, 2, [data(settled)]),
      data(settled), // back in the caller
      ...invocation(PROGRAM, 2, [data(deposited)]),
    ]);
    expect(parseProgramEvents(logs).map((e) => e.name)).toEqual(["Settled", "Deposited"]);
  });

  it("tracks failed inner invocations", () => {
    const logs = invocation(JUPITER, 1, [
      ...invocation(PROGRAM, 2, [data(settled), ...invocation(TOKEN, 3, [data(deposited)], true)], true),
      data(settled), // the caller again, not us
    ]);
    expect(parseProgramEvents(logs).map((e) => e.name)).toEqual(["Settled"]);
  });

  it("is not fooled by program log lines", () => {
    const logs = invocation(PROGRAM, 1, [
      `Program log: failed to do something`,
      `Program log: ${JUPITER} invoke [2]`,
      data(settled),
      `Program return: ${PROGRAM} AQ==`,
    ]);
    expect(parseProgramEvents(logs).map((e) => e.name)).toEqual(["Settled"]);
  });

  it("skips unknown discriminators and short payloads", () => {
    const logs = invocation(PROGRAM, 1, [
      data(new Uint8Array(16).fill(9)),
      data(new Uint8Array(3)),
      data(settled),
    ]);
    expect(parseProgramEvents(logs)).toHaveLength(1);
  });

  it("takes the program id as a parameter", () => {
    expect(parseProgramEvents(invocation(JUPITER, 1, [data(settled)]), JUPITER as Address)).toHaveLength(1);
    expect(parseProgramEvents(invocation(JUPITER, 1, [data(settled)]))).toHaveLength(0);
  });
});

describe("eventOwner", () => {
  it("is the owner, the buyer for CreditsBought, null for protocol events", () => {
    expect(eventOwner("Settled", { owner: ALICE })).toBe(ALICE);
    expect(eventOwner("CreditsBought", { buyer: BOB, amount: "1" })).toBe(BOB);
    expect(eventOwner("BackupGatewayActivated", { gateway: BOB })).toBeNull();
    expect(eventOwner("ShutDown", {})).toBeNull();
  });
});
