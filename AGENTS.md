# Repository guidance

- Preserve the current local deployment behavior and the existing HTTP, SSE, and SDK contracts unless a change is strictly additive.
- Treat `packages/core/src/infra` as the shared adapter-contract layer. Infrastructure implementations belong behind those contracts; do not add provider-specific branches throughout the API or agent loop.
- Every distributed data operation must carry tenant scope and must enforce it in the adapter, not only at the route layer.
- Durable events are written to the state store before fan-out. Event sequence allocation must be atomic with event persistence in distributed mode.
- Keep secrets out of API responses and logs. Tool execution must retain the existing approval, policy, timeout, cancellation, and workspace boundary checks.
- Make one migration phase at a time. Update `PLAN.md`, `TODO.md`, `README.md`, and `docs/SCALING.md` as the architecture changes; do not mark an item complete until its required checks pass.
- Run focused tests for the changed adapter and preserve local-mode test/eval behavior. Do not claim distributed readiness without Postgres/Redis integration and multi-node replay coverage.
