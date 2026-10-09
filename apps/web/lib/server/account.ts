import "server-only";
import { type ProgramState, readUser, readWallet, type UserState, type WalletState } from "../chain/read";
import { getProgram } from "./program";
import { serverRpc } from "./rpc";

export type Account = { program: ProgramState; user: UserState; wallet: WalletState };

/** Program, API balance and wallet balances for one owner, straight from the chain. null = program not live. */
export async function loadAccount(owner: string): Promise<Account | null> {
  const program = await getProgram();
  if (!program) return null;
  const rpc = serverRpc();
  const [user, wallet] = await Promise.all([readUser(rpc, owner), readWallet(rpc, owner, program)]);
  return { program, user, wallet };
}
