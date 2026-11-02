<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Stock, sales, transfers and installment payments change state only through security-definer SQL functions (create_sale, create_transfer, receive_transfer, pay_installment, admin_set_user); why: keeps IMEI status, ledger and schedules atomic and permission-checked.
- Branch scoping is enforced in RLS via can_access_branch / can_operate_branch; HQ roles see all branches; why: one database serves 100+ showrooms safely.
- UI strings are English by default with a Bangla dictionary in src/lib/i18n.tsx; why: user chose English with a Bangla toggle.
- Finance partner settlements go through settle_finance (marks case settled + writes income ledger row atomically); camera scanning is one shared ScanButton component using the BarcodeDetector API with a WASM fallback, so every screen gets the same scan behaviour.
- Finance partner cash movements go through partner_payment / settle_finance, which write finance_partner_ledger and transactions together; why: partner balances and cash balance never drift apart.
- Offline work (POS sales, kisti, expenses) is queued on-device in src/lib/offline.ts and replayed through apply_offline_op, which applies each client_ref once and records failures as conflicts (first sync wins); the query cache is persisted to IndexedDB and the app-shell service worker is registered only via src/lib/sw-register.ts; why: showrooms keep selling without internet without double-applying or silently losing entries.
- The Windows desktop app (electron/main.cjs) is a thin Electron shell around the published URL, packaged with @electron/packager outside the project; why: one codebase, and desktop gets updates on every publish.
