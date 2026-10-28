// The operator console's rules now live in common/opsRules.js, so the operator service and the admin API read the same constants and the same
// ten rules rather than two copies that drift. This file keeps the old import path working.
export * from '../../common/opsRules.js';
