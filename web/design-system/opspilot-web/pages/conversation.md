# Conversation Page Overrides

> **PROJECT:** OpsPilot Web
> **Generated:** 2026-09-03 16:15:13
> **Page Type:** Dashboard / Data View

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1400px or full-width
- **Grid:** 12-column grid for data flexibility

### Spacing Overrides

- **Content Density:** High — optimize for information display

### Typography Overrides

- No overrides — use Master typography

### Color Overrides

- No overrides — use Master colors

### Component Overrides

- Avoid: Present AI as human
- Avoid: Static output only
- Avoid: Single row actions only
- Use: Message → attachment → tool step → result as one visible workflow
- Use: Expandable execution details with current step, progress, and latest output
- Use: Persistent composer with removable file chips and visible submit feedback

---

## Page-Specific Components

- No unique components for this page

---

## Recommendations

- Effects: Hover tooltips, chart zoom on click, row highlighting on hover, smooth filter animations, data loading spinners
- AI Interaction: Clearly label AI generated content
- AI Interaction: Thumps up/down or 'Regenerate'
- AI Interaction: Stream status should be announced through one contextual live region
- Data Entry: Allow multi-select and bulk edit
