import type { Deferred } from "effect"
import type { AdmissionState } from "./admission-state.ts"
import type { AdmissionFailure } from "./admission-contracts.ts"
import type { Lease, Gate } from "./admission-events.ts"
export type RevocationResult = {
  readonly operation: bigint
  readonly result: Deferred.Deferred<void, AdmissionFailure>
}
/** Resource retention follows immutable obligations, including the prerequisites already captured by waiters. */
export const retainAdmissionResources = (
  state: AdmissionState,
  leases: readonly Lease[],
  gates: readonly Gate[],
  results: readonly RevocationResult[]
) => {
  const retained = (operation: bigint) => state.entries.some((entry) => entry.core.operation === operation)
  return {
    leases: leases.filter((item) => retained(item.operation)),
    gates: gates.filter((item) => retained(item.operation)),
    results: results.filter(
      (item) =>
        state.revocations.some((work) => work.command.operation === item.operation) ||
        state.entries.some((entry) => entry.prerequisites.includes(item.operation))
    )
  }
}
