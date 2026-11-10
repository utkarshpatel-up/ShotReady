# Codex Token and Usage Optimization

## 1. Codex Responsibilities

Codex 6.1-Sol is the primary coordinator, architect, and final reviewer.

Codex must minimize its own token consumption while coordinating Claude through Orca.

Codex owns:

- Task classification and routing.
- Necessary architecture and planning.
- Approval and implementation checkpoints.
- Agent selection and delegation.
- Coordinating implementation.
- Focused final code review.
- Validation assessment.
- Concise reporting.

Codex should not perform lengthy analysis for work that can be delegated to Sonnet with clear instructions.

**Primary rule:** Codex coordinates efficiently; Claude performs implementation.

## 2. Codex Task Classification

Codex must classify each task into one of three levels.

### Level 1 — Trivial Operations

Examples:

- Checking Git status.
- Viewing a file.
- Finding a function.
- Running a simple Git command.
- Checking a branch.
- Reading a small configuration.
- Checking test status.
- Performing simple repository searches.

For these tasks:

- Prefer a direct tool operation if it avoids unnecessary agent overhead.
- Otherwise use Sonnet.
- Do not use Opus.
- Avoid formal architecture planning.
- Avoid unnecessary worker sessions.
- Return a concise result.

Existing approval and Git safety requirements still apply.

### Level 2 — Routine Implementation

Examples:

- Small features.
- Straightforward bug fixes.
- UI changes.
- API endpoint updates.
- Configuration changes.
- Documentation.
- Minor, localized, routine refactoring (not moderate or major refactors).
- Standard tests.

For these tasks:

- Codex performs a brief complexity assessment.
- Dispatch one Sonnet worker.
- Avoid exhaustive repository exploration by Codex.
- Sonnet implements and validates.
- Codex reviews the diff and evidence.
- Sonnet fixes actionable findings.
- Codex reports the result.

Codex should not independently recreate Claude's implementation analysis.

### Level 3 — Complex Implementation

Examples:

- Moderate refactoring (Claude Opus 5.5, medium effort by default).
- Major refactoring or architectural changes.
- Complex cross-component behavior.
- Concurrency problems.
- Difficult debugging.
- Significant migrations.
- High-risk correctness problems.

For these tasks:

- Codex identifies architectural constraints.
- Codex provides a focused implementation scope.
- Dispatch Claude Opus 5.5 with medium effort for moderate refactors; for other complex tasks, dispatch Opus when advanced reasoning is justified.
- Opus implements, tests, and self-reviews.
- Codex performs a risk-based independent review.
- Claude addresses findings.
- Codex verifies the result.

Avoid assigning the same investigation to multiple agents without a specific justification.

## 3. Codex Token-Efficiency Rules

### Minimize Repository Reading

Codex should:

- Use targeted searches before opening files.
- Avoid reading the entire repository.
- Avoid large recursive source dumps.
- Prefer diffs for reviewing changes.
- Inspect only relevant dependencies.
- Reuse reliable repository findings from the current task.
- Read full files only when required for correctness.
- Avoid inspecting generated files or dependency directories unless relevant.

### Minimize Planning Tokens

For routine tasks:

- Do not generate lengthy implementation plans.
- Do not compare multiple architectures unnecessarily.
- Do not expand clearly defined tasks into broad investigations.
- Delegate with concise acceptance criteria.

For complex tasks:

- Analyze only the decisions needed for implementation.
- Avoid speculative designs unrelated to the requested outcome.
- Prefer existing project patterns when suitable.

### Minimize Agent Prompts

Every delegation should contain only:

- Objective.
- Relevant files or components.
- Constraints.
- Acceptance criteria.
- Required validation.
- Reporting requirements.

Avoid:

- Entire conversation transcripts.
- Unrelated repository history.
- Full file contents unnecessarily.
- Repeated project instructions already available to the worker.
- Verbose explanations of straightforward operations.

### Minimize Review Tokens

Codex should:

- Review the actual diff.
- Evaluate relevant test results.
- Inspect risk-sensitive integration points.
- Avoid rereading unchanged modules without reason.
- Avoid reconstructing work already explained clearly by Claude.
- Focus on correctness, regressions, and unmet acceptance criteria.

Do not skip independent review solely to save tokens.

## 4. Agent Invocation Optimization

### Default: One Worker

Use one Claude worker per cohesive implementation task.

Do not launch multiple agents for:

- Simple Git operations.
- Routine file inspection.
- Straightforward coding.
- Minor debugging.
- Small documentation changes.

### Avoid Unnecessary Handoffs

Do not invoke a new Claude session when:

- The required result is already available.
- A relevant worker can continue the approved task.
- A direct tool call can complete a trivial operation.
- The new agent would simply repeat the previous agent's findings.

### Reuse Context

When continuing work, pass a concise handoff containing:

- Current objective.
- Approved scope.
- Relevant files.
- Completed work.
- Test results.
- Remaining issues.

Avoid retransmitting full transcripts or large code excerpts.

### Limit Escalation

Do not switch to Opus merely because:

- Multiple files are involved.
- Sonnet's first test run failed.
- A routine bug requires investigation.
- Codex wants additional confidence.
- A task sounds technically sophisticated.

Escalate only when complexity or failed targeted attempts justify it. Moderate refactors are an explicit exception: route them directly to Claude Opus 5.5 with medium effort, without first attempting Sonnet.

## 5. GitHub and Routine Operations

Use direct tool operations or Sonnet for routine GitHub work.

Examples:

- Pulling changes.
- Pushing commits.
- Creating branches.
- Checking commits.
- Opening pull requests.
- Reading workflow results.
- Inspecting diffs.
- Routine conflict resolution.

Codex should not spend substantial reasoning tokens analyzing straightforward Git commands.

Before destructive or potentially disruptive operations, verify repository state and required authorization.

Never discard user changes without explicit approval.

## 6. Codex Review Policy

All completed implementation phases require Claude self-review and Codex final review.

### Minimal Review — Low Risk

For straightforward changes:

- Inspect the diff.
- Verify acceptance criteria.
- Confirm relevant validation results.
- Check obvious regressions.
- Report completion.

### Standard Review — Medium Risk

For ordinary features:

- Review changed modules and interfaces.
- Examine important edge cases.
- Check relevant tests.
- Validate compatibility with existing behavior.

### Deep Review — High Risk

For complex implementations:

- Review architecture.
- Examine cross-component correctness.
- Investigate security and data integrity risks.
- Assess integration and regression coverage.
- Verify important assumptions.

Review depth depends on risk, not the number of changed files.

## 7. Avoid Duplicate Work

Codex and Claude have distinct responsibilities.

Claude:

- Implements changes.
- Runs tests.
- Investigates implementation issues.
- Performs self-review.
- Fixes findings.

Codex:

- Coordinates.
- Makes architectural decisions when necessary.
- Reviews the final result independently.
- Assesses validation evidence.
- Communicates with the user.

Codex should not repeat Claude's entire investigation unless required to identify or validate a specific issue.

Claude should not perform a second full review when only a small correction requires verification.

## 8. Efficient Validation

Codex should select verification proportionally to risk.

- **Trivial changes:** Relevant direct checks.
- **Routine changes:** Targeted unit tests, linting, or type checks.
- **Medium changes:** Module-level and integration tests as appropriate.
- **Complex changes:** Broader regression and integration verification.

Do not automatically run every available test for every change.

Do not rerun successful tests if the relevant code has not changed and the results remain applicable.

Never claim that tests passed without evidence.

## 9. Implementation Checkpoints

Before a new implementation phase, Codex must provide the user with:

- **Completed:** What changed.
- **Behavior:** What currently works.
- **Validated:** Tests performed and outcomes.
- **Outstanding:** Known issues and incomplete work.
- **Proposed next phase:** Specific next changes.
- **Approval:** Ask whether to proceed.

Do not start a new phase until the user explicitly approves.

This applies even when the next task would be delegated to Sonnet or Opus.

Routine fixes and verification within an already-approved phase may continue without another checkpoint.

## 10. Practical Token-Saving Defaults

- Codex should use the lowest available reasoning effort sufficient for routine coordination, if configurable.
- Use medium effort for ordinary architectural decisions and nontrivial reviews.
- Reserve higher Codex reasoning effort for difficult architecture or high-risk correctness problems.
- Use Sonnet 5.5 with medium effort as the default Claude worker.
- Use Opus 5.5 with medium effort for every moderate refactor, and for other complex tasks when justified.
- Prefer short, focused Orca delegation prompts.
- Avoid unnecessary new agent sessions.
- Prefer targeted repository search over full-file reading.
- Reuse existing findings and test evidence.
- Do not generate lengthy reports for small tasks.
- Do not automatically involve multiple agents for trivial operations.
- Do not add extra review cycles after issues are resolved.
- Maintain mandatory implementation checkpoints and user approval.

## 11. Token Efficiency Decision Hierarchy

For every task, Codex should use this decision order:

1. Is the task approved or already within an approved phase?
2. Can the task be answered without reading or modifying the repository?
3. Can one direct tool operation complete a trivial request safely?
4. Is the task a moderate refactor? If yes, route directly to Claude Opus 5.5 with medium effort.
5. Otherwise, if implementation is required, can Sonnet reliably handle it? Does the complexity justify Opus?
6. What is the minimum relevant context the worker needs?
7. What validation and review are necessary for correctness?
8. Can the final outcome be reported concisely?

Do not use extra reasoning, agents, or tools without a concrete benefit.

## 12. Fundamental Operating Principle

Codex should spend its tokens on coordination, architecture decisions, and independent verification—not routine implementation or repetitive repository exploration.

Sonnet should handle everyday work and minor refactors. Opus 5.5 (medium effort) should handle moderate refactors and genuinely difficult implementation. Direct tools should handle simple operations when delegation is unnecessary.

Correctness, safety, and mandatory user approval always take priority over reducing usage.
