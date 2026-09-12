# Profile usage and price comparison

- Profiles and signed-in billing show the plan's full end date, or free-trial days remaining.
- Separate plan/trial and extra-credit meters show available credits, allocation, percentage remaining and each bucket's expiry. Prepaid plan end and monthly refill remain distinct.
- Grants are read under the authenticated client's RLS, after the status RPC refreshes installments. Future installments, expired grants and refunds do not inflate available allocation; exhausted trial dates remain visible. Active paid plans are not relabelled by a Top-up.
- Credit grant read errors propagate as unavailable, never a fabricated zero. Missing denominators do not render a 100% meter. Expiry prefers grants that still have credits.
- Classroom profile refreshes on open and every minute while visible. Mobile menu stays inside the viewport and has a close button.
- No artificial “30% off” or invented former prices. Semester/Half-year/Annual compare against the actual localized Monthly total for the same duration, explicitly labelled. Charge prices remain Paddle's unchanged totals. No catalog, billing policy or database changes.

## Verification

- 354 automated tests passed; local production build passed.
- Chrome checked classroom profile, public profile and billing in English/Korean at 390/1440 px, with light/dark screenshots; expired trial and zero/partial balances covered. Mobile clipping found and fixed.
- Synthetic local account/API data only; no actual purchases or customer recordings.
- Temporary QA route removed before deployment.
- Deployment: `dpl_3APaLcF4KQ87txwpyGvwE7kimXMR`, ready at https://www.lecue.app. Initial transient authorization error resolved on retry after verifying project access.
- Production Chrome: live KRW Monthly comparisons ₩55,600 / ₩83,400 / ₩166,800; mocked USD preview $39.96 / $59.94 / $119.88 rendered correctly on desktop/mobile with no page errors or horizontal overflow. No purchase submitted.
- Date rendering starts in UTC for server/client consistency, then uses the viewer's local time zone.
