import type { Db } from "@unspent/db";

export type { Db } from "@unspent/db";
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
