# Language experience — 2026-09-08

- Overseas: English is the default. Korean is under Other languages. Korea keeps Korean/English directly accessible.
- Country comes from hosting request headers; without a country, browser language is used, then English. Explicit saved choices and language URLs remain respected.
- Display translations remain English/Korean. Added languages apply to lecture transcription, not UI translation.
- Speech choices: English, Korean, Spanish, Japanese, Mandarin Chinese, French, German, Portuguese, Hindi. Overseas defaults to English; Korea defaults to the existing Korean + English mode. Saved speech choices survive reloads.
- Additional single languages use Deepgram Nova-3 for live and uploaded audio. Korean + English live recognition keeps Soniox; mixed-language uploads retain Korean recognition, disclosed in the selector helper.
- Public landing, login, billing and legal pages share a regional language control. Switching preserves destination query parameters and anchors.
- Fixed narrow-screen legal table overflow discovered during verification.

## Verification

- 337 automated tests passed; type checking and local production build passed.
- Real classroom UI: Korea/overseas × desktop/mobile, selection persistence, settings alignment, no page errors or horizontal overflow.
- Public UI: eight regional/mobile combinations passed; login destination and anchor preserved when switching language.
- Verification used synthetic local profiles and mocked APIs. No paid transcription calls or language-by-language audio quality evaluation performed.
- Temporary classroom QA route removed before deployment.
- Production deployment: `dpl_EmEibdAsFiABbeVtc3WZoHPydEc8`, ready and aliased to https://www.lecue.app.
- Production Chrome smoke: English landing, login, billing and terms all returned 200 with the updated language control, no page errors or mobile horizontal overflow. Billing shows the new multilingual feature copy. Explicit English preference used for the login check because the test runs from Korea; an unselected login follows the regional default.

## Sources

- [Deepgram supported models and languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Nova-3 keyterm prompting](https://developers.deepgram.com/docs/keyterm)
