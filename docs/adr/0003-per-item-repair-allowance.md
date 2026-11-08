# Use durable repair allowances per verification item

A task-wide repair budget allowed startup failures and early criteria to consume every attempt before later criteria received a fix. Give each acceptance criterion, required check, smoke failure, and canonical review finding its own budget of three attempts, persisted under its stable identity across cycles and resume. All obligations within one criterion share its budget; exhausted items remain unresolved while other items continue, followed by full verification after repairs. Total possible repairs grow with the task’s scope, while the task deadline and separate infrastructure retry allowance remain shared.

Explicit grants add attempts to each item and extend the shared deadline. Human-requested grouped repairs use a separate durable item. Ledger format 4 and epic schema 13 intentionally reject older accounting without migration.
