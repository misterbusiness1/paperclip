# Board Approvals Micro-Decisions

Status: Implemented and production-tested  
Owner: Oxford Cigar Company  
Applies to: `/approvals/pending`, `/approvals/all`, and `/approvals/:approvalId`

## Purpose

Turn each board approval into one small, understandable decision. The board should be able to identify the request, see the recommendation and its tradeoffs, and approve, reject, or request changes without reading an implementation dump.

The interface must preserve the complete request for audit and edge cases, but progressive disclosure keeps that material out of the primary decision path.

## Product principles

1. One card represents one decision.
2. Decision-relevant information appears before supporting detail.
3. Recommendation, reasoning, benefits, and tradeoffs use plain language.
4. Missing fields are stated honestly; the UI does not invent rationale.
5. Full and raw payloads remain available on the detail page.
6. Actions remain close to the decision and clearly show pending state.
7. Twenty records are shown at a time to keep the queue scannable.

## Scope boundary

This specification covers approval-specific presentation and resolution.

Paperclip's separate `/decisions` desk may aggregate approvals with other attention items and provide queues, triage, retention, and archive behavior. It does not replace the approval audit trail described here, and this feature does not duplicate its queue-management behavior.

## Information model

Approval payloads are heterogeneous. The UI derives a consistent decision brief from the first non-empty supported field.

| Display field | Accepted payload fields, in priority order |
| --- | --- |
| Subject | `title`, `name`, `summary`, `recommendedAction` |
| Recommendation | `recommendedAction`, `recommendation`, `proposedAction` |
| Why | `reasoning`, `rationale`, `justification`, `decisionReasoning`, `summary`, `intent`, `guidance`, `description`, `strategy`, `plan`, `capabilities` |
| Pros | `pros`, `benefits`, `reasonsToApprove`, `advantages`, `upside` |
| Cons | `cons`, `risks`, `reasonsNotToApprove`, `tradeoffs`, `drawbacks`, `downside` |
| If approved | `nextActionOnApproval` |

String and string-array values are accepted for Pros and Cons. Blank entries are removed and duplicate entries are removed case-insensitively while preserving their first occurrence.

For compact surfaces, lightweight Markdown is reduced to plain text, whitespace is normalized, and content is clipped at a word boundary. The complete source remains available on the detail page.

## Queue page

### Routes and tabs

- `/approvals/pending` uses the label **To decide** and includes `pending` and `revision_requested` approvals.
- `/approvals/all` uses the label **All decisions** and includes every approval state.
- Results are sorted newest first.
- The page initially shows 20 approvals. **Show 20 more** reveals the next bounded group.

### Approval card

Each card shows:

1. Approval type and status.
2. Subject, requester, and relative creation time.
3. Recommendation, up to 180 characters.
4. Why, up to 220 characters.
5. The first Benefit and first Tradeoff, each up to 160 characters.
6. Approve and Reject when the request is actionable and not a budget stop.
7. A link to the complete approval detail.

The card does not display the raw payload, full discussion, linked work, or every pro and con.

### Empty and error states

- Pending empty state: **Nothing needs a decision.**
- All empty state: **No decisions yet.**
- Query and mutation failures remain visible as error text.
- Only the card being resolved displays its pending action state.

## Approval detail page

The first panel is the decision readout:

- Type, status, subject, requester, and creation time.
- Recommendation, up to 320 characters.
- Why, up to 420 characters.
- Up to three Pros and three Cons, each up to 220 characters.
- If approved, up to 280 characters.
- Existing decision note when present.
- Available resolution actions.

When a recommendation, rationale, benefit, or tradeoff is absent, the interface says that it was not supplied. It must not infer one.

### Actions by state

| State or type | Available primary actions |
| --- | --- |
| `pending` | Approve, Request changes, Reject |
| `revision_requested` | Approve, Reject, Mark resubmitted |
| `approved` | No further resolution action |
| `rejected` | No further resolution action |
| `budget_override_required` | Direct the board to Costs for resolution |

After approval, a confirmation banner explains that the requesting agent was notified and offers the most relevant next destination: linked task, hired agent, or approvals.

### Progressive disclosure

The following sections are collapsed by default:

- **Full request**: the type-specific renderer, request ID, timestamp, and nested raw payload.
- **Supporting details**: linked tasks and the guarded cleanup action for a rejected agent hire.
- **Discussion**: prior comments and the add-context form.

No source information is deleted by the simplified readout.

## Email approval presentation

A request-board-approval payload is treated as an email reply only when it contains:

- a non-empty `body`; and
- at least one of `subject`, `recipient`, or `channel`.

The full request then renders an email-style envelope and prose body, followed by intent, recommendation, and risks. This avoids presenting customer-facing copy as raw JSON.

## Interaction and accessibility requirements

- Use native buttons, links, `details`, and `summary` controls.
- Every form input has an associated label.
- Mutation failures use an alert role on the detail page.
- Decorative list markers are hidden from assistive technology.
- Destructive agent deletion requires explicit confirmation.
- All interactive controls expose disabled and progress states.
- Text remains readable without relying on color alone.
- At narrow widths, metadata, actions, and Pros/Cons wrap or stack without horizontal page scrolling.

## Visual requirements

- Reuse Paperclip design tokens and existing Button, Badge, Card, Identity, and StatusBadge components.
- Keep the primary hierarchy quiet: one bordered decision panel, compact labels, and restrained status treatment.
- Do not add a new color system, icon taxonomy, modal, dependency, or dashboard abstraction.
- Raw data and secondary operations must not compete visually with the decision.

## Acceptance criteria

1. A board member can identify the requested decision and the recommended action from the queue card.
2. Pros and Cons never expose more than one item each on a card or three items each on detail.
3. Long or Markdown-heavy content is converted to a bounded, readable excerpt without corrupting order numbers or comparison symbols.
4. Missing reasoning is labeled as missing rather than fabricated.
5. Approve, Reject, Request changes, and Resubmit preserve their existing API behavior.
6. Budget stops remain resolvable only through Costs.
7. Full request, raw payload, linked work, and discussion remain reachable from detail.
8. Email reply payloads render as an email preview rather than raw JSON.
9. The queue paginates presentation in groups of 20.
10. The UI passes TypeScript, production build, design-token gates, and the approval payload regression suite.

## Verification coverage

Automated checks cover:

- decision-field priority and fallback behavior;
- case-insensitive benefit/tradeoff deduplication;
- Markdown cleanup and word-boundary clipping;
- preservation of order numbers and comparison characters;
- email reply detection and false-positive rejection;
- email envelope, body, reasoning, recommendation, and risk rendering;
- full production typecheck, build, and design-token gates.

Manual staging checks must cover desktop and narrow viewport layouts, keyboard access to every action and disclosure, pending-action feedback, empty states, and the separation between `/decisions` and `/approvals`.

## Rollback

The feature is presentation-only except for calling existing approval actions. Rollback restores the upstream ApprovalCard, Approvals, ApprovalDetail, ApprovalPayload, payload tests, and fixture files; no database rollback is required for this UI feature.
