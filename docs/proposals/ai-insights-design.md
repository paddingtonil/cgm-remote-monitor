# תכן יישום: AI Insights ב-Nightscout

**Document Version:** 1.0  
**Last Updated:** 2026-10-10  
**Status:** Draft (2026 Proposal)  
**Source Spec:** `LoopInsights_AI_Prompts_and_Settings_Spec` (LoopPowerPack 0.3.18, ענף `powerpack-allfeatures-upstream-sync`)  
**Related:** [Architecture Overview](../meta/architecture-overview.md), [Security Audit](../audits/security-audit.md), [Plugin Architecture Audit](../audits/plugin-architecture-audit.md), [Agent Control Plane RFC](./agent-control-plane-rfc.md)

_הערת שפה: מסמכי המאגר כתובים אנגלית. מסמך זה נכתב עברית כדי להתאים למפרט המקור. הפרומטים, שמות הקבצים, שמות השדות והקוד נשארים באנגלית כלשונם. לפני PR למעלה (upstream) יש לתרגם לאנגלית._

---

## תוכן עניינים

1. [תקציר והיקף](#1-תקציר-והיקף)
2. [עקרונות תכן](#2-עקרונות-תכן)
3. [ארכיטקטורה](#3-ארכיטקטורה)
4. [תצורה והגדרות](#4-תצורה-והגדרות)
5. [מיפוי מקורות נתונים](#5-מיפוי-מקורות-נתונים)
6. [מודל נתונים: אוספים חדשים](#6-מודל-נתונים-אוספים-חדשים)
7. [REST API והרשאות](#7-rest-api-והרשאות)
8. [מתאם ספק ה-AI](#8-מתאם-ספק-ה-ai)
9. [זרימות עבודה](#9-זרימות-עבודה)
10. [שכבת האימות והבטיחות](#10-שכבת-האימות-והבטיחות)
11. [אבטחה ופרטיות](#11-אבטחה-ופרטיות)
12. [ממשק משתמש](#12-ממשק-משתמש)
13. [בדיקות](#13-בדיקות)
14. [תכנית ביצוע בשלבים](#14-תכנית-ביצוע-בשלבים)
15. [סיכונים והכרעות פתוחות](#15-סיכונים-והכרעות-פתוחות)
16. [נספח א: מטריצת עקיבות מהמפרט](#נספח-א-מטריצת-עקיבות-מהמפרט)

---

## 1. תקציר והיקף

### 1.1 מטרה

להעביר את יכולות ה-AI של LoopInsights (אפליקציית iOS) לשרת Nightscout, כך שכל משתמש Nightscout (ולא רק משתמשי Loop עם PowerPack) יקבל ניתוח הגדרות טיפול, סיכומי מגמות, צ'אט על הנתונים, תובנות ארוחות ודוח לאנדוקרינולוג. הנתונים כבר קיימים ב-Nightscout: `entries`, `treatments`, `profile`, `devicestatus`.

### 1.2 מה נכנס להיקף (שלבים 1–4)

| תכונה | סעיף במפרט | סטטוס במימוש Nightscout |
|---|---|---|
| Therapy Settings analysis (Basal / CR / ISF, חלונות 3/7/14/30/90) | 6 | מלא |
| Trends & Insights (Daily / Weekly / Monthly / Stats) | 9.1–9.4 | מלא |
| Ask Loopy chat | 9.5 | מלא, כולל live status מ-`devicestatus` |
| Meal Insights: Food-type response + ייעוץ לפי דפוס | 7.1–7.3 | מלא, על בסיס `treatments.foodType` |
| Pre-Meal Advisor | 7.4 | מלא, בלי debriefs בשלב ראשון |
| Meal Debrief | 7.5 | מלא: צילום התחזית נלקח מ-`devicestatus.loop.predicted` |
| Background monitor + התראות | 6.11 | מלא, דרך צינור ההתראות הקיים (Pushover/IFTTT/UI) |
| דוח Endo | 10 | HTML להדפסה (PDF דרך הדפדפן) |
| זיהוי דפוסים לוקלי וציון הגדרות | 6.9, 6.10 | מלא |
| Circadian, Negative basal | 6.6.1–6.6.2 | מלא. שעות שינה: ברירת מחדל 22/7 (אין HealthKit) |
| Caffeine / Alcohol | 6.6.5–6.6.6 | מלא, כ-`treatments` עם `eventType` ייעודי שנרשם מה-Careportal |
| CGM Signal Quality | 6.6.7 | מלא: פערים בין `entries` |
| עלות ותקציב | 3.6 | מלא, ספר חשבונות ב-Mongo |

### 1.3 מה נדחה או מחוץ להיקף

| פריט | סיבה | נקודת חיבור עתידית |
|---|---|---|
| ביומטריה (HR, HRV, שינה, צעדים, משקל, מחזור) | אין HealthKit בשרת | אוסף `activity` של Nightscout כבר מקבל `heartrate`/`steps` ממעלים מסוימים. שלב 5 אופציונלי |
| Stress Score (6.6.3) | תלוי ב-HRV | כנ"ל |
| Behavior Insights (8), User Correction Patterns (6.6.14) | דורש `originalAICarbs` שאינו קיים ב-Nightscout | אם FoodFinder יעלה `aiCarbs`/`aiConfidence` על טיפולי פחמימות, הניתוח יופעל אוטומטית |
| FoodFinder Meal History, Nutritional Correlations (6.6.9–6.6.10) | מקור הנתונים מקומי ל-PowerPack | חלקי: `fat`/`protein` קיימים ב-treatments; `fiber` יתווסף כשדה חופשי |
| MFP Exercise (6.6.13) | אין מקור | `treatments` מסוג `Exercise` יכול להחליף |
| Nightscout Data block (6.6.12) | מיותר: Nightscout הוא המקור | נמחק |
| Apply modes `one_tap` / `pre_fill` / `auto_apply` | Nightscout אינו כותב הגדרות לתוך Loop | רק `manual`. ההצעה מוצגת, והמשתמש משנה ב-Loop. ראו 15.2 |
| AutoPresets AI Advisor, CaregiverDigest | מחוץ להיקף גם במפרט | — |

---

## 2. עקרונות תכן

1. **כל קריאות ה-AI מהשרת בלבד.** ה-CSP של Nightscout (`connectSrc: 'self'`) חוסם קריאות דפדפן לספק חיצוני, והמפתח אסור שיגיע ללקוח. הדפדפן מדבר רק עם `/api/v1/aiinsights/*`.
2. **פלאגין, לא שינוי ליבה.** לפי `CONTRIBUTING.md`: תכונה חדשה חיה בפלאגין ואינה דורשת שינוי בפלאגינים קיימים. נקודות המגע עם הליבה: רישום ב-`lib/plugins/index.js`, mount מותנה ב-`lib/api/index.js`, אוספים ב-`env.js`, דף ב-`app.js`. כולן מותנות ב-`ENABLE=aiinsights`.
3. **שכבת האימות אינה תלויה בפרומט.** סעיף 6.7 במפרט ממומש בקוד שרת (`validator.js`) ונבדק ביחידה. הפרומט מבקש 20%/10%, הקוד אוכף 25%/15% עם clamp, בדיוק כמו במקור.
4. **mg/dL פנימי, המרה בפלט.** כל האגרגציה והפרומטים ב-mg/dL. בלוק `UNIT CONTEXT` מורה למודל להמיר. שדות `current_value`/`proposed_value` של ISF נשארים mg/dL גם בתשובה וגם ב-Mongo. התצוגה ממירה לפי `settings.units`.
5. **ייעוץ בלבד.** אין כתיבה ל-`profile` ואין שליחת פקודות ל-Loop. ההצעות נשמרות, מוצגות, ומסומנות ידנית כ-applied / dismissed / reverted.
6. **עבודה אסינכרונית.** קריאת LLM אורכת עד 60 שניות. ספקי אירוח נפוצים ל-Nightscout (Heroku, Railway, Fly) מנתקים בקשות אחרי ~30 שניות. לכן כל ניתוח הוא job: `POST` מחזיר 202 עם `jobId`, הלקוח מתשאל, והתוצאה נשמרת ב-Mongo.
7. **ללא תלויות חדשות.** `fetch` מובנה ב-Node 20+ (המאגר דורש `node >=20`). ללא SDK של ספקים. `sanitize-html` כבר קיים לניקוי פלט המודל.
8. **בטיחות קודמת לכול.** אי אפשר להפעיל ניתוח בלי `AIINSIGHTS_API_KEY` ובלי אישור הצהרת הפרטיות (סעיף 11.4). שגיאה בכל שלב מחזירה אפס הצעות, לעולם לא הצעה חלקית.

---

## 3. ארכיטקטורה

### 3.1 תרשים

```
┌────────────────────────── Browser ──────────────────────────┐
│  /insights page (new)        │  Dashboard pill "AI"          │
│  tabs: Settings | Trends |   │  (lib/plugins/aiinsights.js,  │
│  Ask | Meals | Report | ⚙    │   client side, no secrets)    │
└──────────────┬───────────────┴───────────────┬───────────────┘
               │ /api/v1/aiinsights/*  (JWT / api-secret)      │ /api/v1/status.json
               ▼                                               ▼
┌───────────────────────────── Express (lib/api/aiinsights/) ─────────────────┐
│  router → isPermitted('api:aiinsights:<area>:<verb>') → rate limit → handler │
└──────────────┬──────────────────────────────────────────────────────────────┘
               ▼
┌───────────────────────────── lib/aiinsights/ (new, server only) ────────────┐
│ jobs.js        ─ in-memory job queue, 1 concurrent LLM call, persisted result │
│ aggregator.js  ─ glucose/insulin/carb stats, hourly avgs (spec 6.3)          │
│ analyzers.js   ─ circadian, negative basal, food response, patterns, score   │
│ context.js     ─ supplemental blocks (6.6), therapy context (9.4), live (9.5)│
│ prompts/       ─ settings.js, trends.js, chat.js, meal.js (verbatim texts)   │
│ validator.js   ─ parse + post-parse safety (6.7, 6.8)                        │
│ provider.js    ─ OpenAI / Anthropic / Gemini adapter (3.x)                   │
│ usage.js       ─ token estimate, pricing table, budget gate (3.6)            │
│ monitor.js     ─ background monitor on bus 'tick' (6.11)                     │
└──────┬──────────────────────┬───────────────────────────┬───────────────────┘
       ▼                      ▼                           ▼
 ctx.entries / ctx.treatments   lib/server/aiinsights-store.js    fetch() → provider
 ctx.profile / ctx.devicestatus  (ai_suggestions, ai_analyses,
 (existing list() APIs)          ai_usage, ai_settings)
```

### 3.2 קבצים חדשים

| נתיב | תפקיד | מקבילה במפרט |
|---|---|---|
| `lib/plugins/aiinsights.js` | פלאגין Nightscout: `pluginType: 'pill-status'`, `getEventTypes` (Caffeine/Alcohol), property עם סיכום ההצעות הממתינות, `checkNotifications` לניטור רקע | 6.11, 6.6.5–6.6.6 |
| `lib/aiinsights/index.js` | factory `(env, ctx) => service`, נוצר ב-`bootevent.setupInternals` רק אם `isEnabled('aiinsights')` | — |
| `lib/aiinsights/aggregator.js` | `aggregate(from, to, opts)` → `AggregatedData` | 6.3 |
| `lib/aiinsights/basal-integrator.js` | שחזור מסירת בזאלי מ-profile + Temp Basal + Suspend ב-5 דקות | 6.3 אינסולין, 6.6.2 |
| `lib/aiinsights/analyzers.js` | `circadian`, `negativeBasal`, `foodResponse`, `cgmQuality`, `detectPatterns`, `settingsScore`, `caffeine`, `alcohol` | 6.6, 6.9, 6.10, 7.1 |
| `lib/aiinsights/context.js` | `buildSupplementalContext`, `buildTherapyContext`, `buildLiveStatus`, `buildRecentGlucose`, `buildEngagement` | 6.6, 9.4, 9.5 |
| `lib/aiinsights/prompts/units.js` | `unitContext(units)`, `personality(key)` | 5.1, 5.2 |
| `lib/aiinsights/prompts/settings.js` | `systemPrompt()`, `userPrompt(input)` | 6.4, 6.5 |
| `lib/aiinsights/prompts/trends.js` | | 9.1, 9.2 |
| `lib/aiinsights/prompts/chat.js` | | 9.5 |
| `lib/aiinsights/prompts/meal.js` | advice, preMeal, debrief | 7.3, 7.4, 7.5 |
| `lib/aiinsights/validator.js` | `parseSettingsResponse`, `parseTrends`, `parseDebrief`, guardrails | 6.7, 6.8, 9.3, 7.5 |
| `lib/aiinsights/provider.js` | `detectFormat`, `buildRequest`, `extractText`, `sendPrompt`, `testConnection` | 3.1–3.5 |
| `lib/aiinsights/usage.js` | `estimateTokens`, `pricing`, `estimateCost`, `budgetGate` | 3.6 |
| `lib/aiinsights/jobs.js` | תור עבודות | — |
| `lib/aiinsights/monitor.js` | ניטור רקע | 6.11 |
| `lib/server/aiinsights-store.js` | גישה ל-4 האוספים, `indexedFields` | 11 (טבלה) |
| `lib/api/aiinsights/index.js` | Express router | — |
| `views/insightsindex.html` | דף `/insights` | — |
| `lib/insights/insightsclient.js` | קוד לקוח (נחשף ב-`bundle.source.js` כ-`window.Nightscout.insightsclient`) | — |
| `static/insights/js/insightsinit.js`, `static/insights/css/insights.css` | | — |
| `tests/aiinsights-*.test.js` | ראו סעיף 13 | — |

### 3.3 נקודות מגע עם קוד קיים

| קובץ | שינוי |
|---|---|
| `lib/plugins/index.js` | הוספת `require('./aiinsights')(ctx)` ל-`clientDefaultPlugins` ול-`getServerDefaultPlugins()`. הפלאגין עצמו אינו טוען `provider.js`, לכן אין צורך בתרגיל `eval('require')` |
| `lib/server/env.js` | `setAiApiKey()` (מודל `setAPISecret`), 4 שמות אוספים, `stringSettings.aiinsights = ['model', 'baseUrl', 'endpointPath', 'apiVersion', 'organizationId']` |
| `lib/server/enclave.js` | `setAiApiKey` / `getAiApiKey` (Symbol-keyed, לא ניתן לסריאליזציה) |
| `lib/settings.js` | `secureSettings` מקבל `'apiKey'` (הגנת עומק; המפתח ממילא לא נכנס ל-extendedSettings) |
| `lib/server/bootevent.js` | `setupInternals`: `ctx.aiinsights = require('../aiinsights')(env, ctx)` מותנה; `ensureIndexes`: 4 אוספים |
| `lib/api/index.js` | `if (ctx.aiinsights) app.all('/aiinsights*', require('./aiinsights/')(app, wares, ctx, env));` |
| `lib/server/app.js` | `appPages['/insights'] = { file: 'insightsindex.html', title: 'AI Insights', type: 'insights' }` |
| `bundle/bundle.source.js` | `insightsclient: require('../lib/insights/insightsclient')` |
| `lib/authorization/storage.js` | תפקיד ברירת מחדל חדש `ai-insights` (ראו 7.2) |
| `translations/en/en.json` | מחרוזות UI חדשות |
| `README.md` | סעיף `aiinsights` בתיעוד הפלאגינים + משתני אוספים |
| `package.json` | הוספת קבצי הבדיקה החדשים לרשימת `test:unit` |

---

## 4. תצורה והגדרות

### 4.1 שתי שכבות

- **env (שרת, אדמין):** הפעלה, ספק, מפתח, ברירות מחדל. נקרא פעם אחת בעלייה. בהתאם למנגנון `findExtendedSettings`, כל `AIINSIGHTS_FOO_BAR` הופך ל-`extendedSettings.aiinsights.fooBar`.
- **Mongo `ai_settings` (משתמש, דרך ה-UI):** מסמך יחיד שמחליף ערכי env הניתנים לשינוי. נכתב דרך `PUT /api/v1/aiinsights/settings` בהרשאת `api:aiinsights:settings:update`. ערך חסר במסמך נופל ל-env, וערך חסר ב-env נופל לברירת המחדל שבמפרט.

ההחלטה הזו משקפת את העובדה ש-Nightscout הוא מופע לחולה יחיד: ההגדרות שב-LoopInsights יושבות ב-`UserDefaults` של מכשיר אחד, וכאן הן יושבות במסמך אחד.

### 4.2 משתני סביבה

| משתנה | ברירת מחדל | הערות | מקור במפרט |
|---|---|---|---|
| `ENABLE=... aiinsights` | כבוי | מתג ראשי (`LoopInsights_isEnabled`) | 4 |
| `AIINSIGHTS_API_KEY` / `AIINSIGHTS_API_KEY_FILE` | — | נקרא ל-enclave ונמחק מ-`process.env`. לעולם לא ב-settings | 3.1 `apiKey` |
| `AIINSIGHTS_BASE_URL` | `https://api.openai.com/v1` | | 3.1 |
| `AIINSIGHTS_MODEL` | `gpt-4o` | | 3.1 |
| `AIINSIGHTS_REQUEST_FORMAT` | אוטומטי מה-URL | `openai` / `anthropic` / `gemini` | 3.2 |
| `AIINSIGHTS_ENDPOINT_PATH` | לפי פורמט | | 3.1 |
| `AIINSIGHTS_API_VERSION` | — | Azure | 3.1 |
| `AIINSIGHTS_ORGANIZATION_ID` | — | כותרת `OpenAI-Organization` | 3.1 |
| `AIINSIGHTS_MAX_TOKENS` | 8192 | נאכף 8192 בכל מקרה (ראו 8.1) | 3.1 |
| `AIINSIGHTS_ALLOW_PRIVATE_URL` | `false` | מתיר `baseUrl` לכתובת פרטית (Ollama/LM Studio מקומי). ראו 11.2 | — |
| `AIINSIGHTS_PRIVACY_ACK` | `false` | חייב להיות `true` כדי לשלוח נתונים לספק. ראו 11.4 | — |
| `AIINSIGHTS_DEBUG_PROMPTS` | `false` | רישום פרומטים מלאים ללוג (פיתוח בלבד) | — |
| `MONGO_AI_SUGGESTIONS_COLLECTION` | `ai_suggestions` | | — |
| `MONGO_AI_ANALYSES_COLLECTION` | `ai_analyses` | | — |
| `MONGO_AI_USAGE_COLLECTION` | `ai_usage` | | — |
| `MONGO_AI_SETTINGS_COLLECTION` | `ai_settings` | | — |

### 4.3 מסמך `ai_settings` (ניתן לעריכה ב-UI)

מיפוי אחד לאחד למפתחות `LoopInsights_*` במפרט סעיף 4, פרט לדגלים שאין להם מקור נתונים (ראו 1.3).

```json
{
  "_id": "default",
  "analysisPeriod": 14,
  "aiPersonality": "supportive_coach",
  "tightRangeUpperBound": 140,
  "features": {
    "circadian": false,
    "foodResponse": false,
    "mealDebrief": false,
    "preMealAdvisor": false,
    "caffeineTracking": false,
    "alcoholTracking": false,
    "cgmBackfillDetection": false,
    "agpChart": false
  },
  "monitor": {
    "enabled": false,
    "frequency": "weekly",
    "minConfidence": "medium",
    "quietHours": { "enabled": false, "start": 22, "end": 7 },
    "notificationStyle": "push"
  },
  "budget": {
    "monthlyCapUsd": 0,
    "warnPercent": 80,
    "hardBlock": false,
    "confirmBeforeCall": false
  },
  "sleepSchedule": { "bedHour": 22, "wakeHour": 7 },
  "developerMode": false,
  "modified_at": "2026-10-10T08:00:00.000Z"
}
```

- `sleepSchedule` חדש: מחליף את זמני השינה מ-HealthKit בבלוק Circadian (6.6.1).
- `mealDebrief` ו-`preMealAdvisor` נאכפים כתלויים ב-`foodResponse`, כמו במפרט.
- `developerMode` חושף רק `useTestData` ואת תצוגת הפרומט הגולמי. אין `auto_apply`.
- אימות קלט ב-`PUT`: `analysisPeriod ∈ {3,7,14,30,90}`, `tightRangeUpperBound ∈ [120,160]` בצעדי 5, `aiPersonality` מתוך 4 הערכים, שעות 0–23, `warnPercent ∈ [0,100]`.

---

## 5. מיפוי מקורות נתונים

### 5.1 שאילתות בסיס

כל הקריאות דרך המודולים הקיימים, לא ישירות ל-Mongo. `fromMs`/`toMs` הם גבולות החלון, `period` במספר ימים.

| נתון | קריאה | הערות |
|---|---|---|
| גלוקוז | `ctx.entries.list({ find: { date: { $gte: fromMs, $lte: toMs }, type: 'sgv' }, sort: { date: 1 }, count: 288 * period + 100 }, cb)` | `sgv` ב-mg/dL תמיד. ערכי `sgv < 39` (קודי שגיאה) מסוננים |
| טיפולים | `ctx.treatments.list({ find: { created_at: { $gte: fromISO, $lte: toISO } }, sort: { created_at: 1 }, count: 20000 }, cb)` | מספר `isValid != false` מסונן אוטומטית |
| פרופיל | `ctx.profile.list(cb, 10)` ואז `profilefunctions.loadData` + `profileFromTime(ms)` | פרופיל אחד לכל רגע בחלון; שינוי פרופיל באמצע החלון מצוין בפרומט |
| devicestatus | `ctx.devicestatus.list({ find: { created_at: { $gte, $lte } }, sort: { created_at: 1 }, count: 288 * period + 100 }, cb)` | רק מסמכים עם `loop` או `openaps` |

### 5.2 גלוקוז (מפרט 6.3)

ישיר מ-`entries`. החישובים כלשונם: SD אוכלוסייה, CV, חמשת הדליים, TITR לפי `tightRangeUpperBound`, GMI `3.31 + 0.02392 × mean`, ממוצעים שעתיים לפי שעה מקומית.

**אזור זמן:** השעה המקומית נגזרת מ-`profilefunctions.getTimezoneAt(mills)` (תומך ב-Profile Switch עם אזור זמן), ולא מאזור הזמן של השרת. זה ההבדל המרכזי מהמימוש ב-iOS, שבו המכשיר תמיד מקומי.

### 5.3 אינסולין (מפרט 6.3)

Nightscout אינו מקבל "מנות" כמו `DoseStore`. `basal-integrator.js` משחזר:

1. רשת של 5 דקות על החלון.
2. לכל תא: `profile.getTempBasal(mills)` מהפונקציות הקיימות ב-`profilefunctions.js`, שכבר משלב בזאלי מתוזמן, Temp Basal (`absolute`/`percent`/`rate`), ו-Combo Bolus. התוצאה `totalbasal` ביחידות לשעה × 5/60.
3. **השעיה** = Temp Basal עם `rate === 0` או `absolute === 0`, או `eventType` מתוך `['Suspend Pump', 'Pump Suspend']`, או `devicestatus.pump.status.suspended === true` בטווח. נספר כאירוע עם דקות.
4. **sub-basal** = תא שבו `tempbasal < basal` מתוזמן (סעיף 6.6.2).
5. **בולוסים** = `treatments.insulin > 0`. סכום בולוס לפי יום.
6. **תיקונים**: `eventType === 'Correction Bolus'`, או `insulin > 0` ו-`carbs` ריק ואין טיפול פחמימות בטווח ±15 דקות. אם קיים השדה `automatic: true` (Loop מעלה אותו על בולוסים אוטומטיים) הוא נספר כתיקון אלגוריתמי ומוצג בנפרד בפרומט: `Correction Boluses: {n} in period ({auto} automatic)`.
7. TDD יומי = בזאלי משוחזר + בולוסים. מכאן min/max/CV ו-Week-over-Week (רק ל-≥14 יום).

**fallback:** אם קיים `devicestatus.pump.extended.TDD` או `openaps.iob.TDD` (AAPS/Trio מעלים), הוא עדיף על השחזור, ומסומן בפרומט כ-`(reported by pump)`.

### 5.4 פחמימות ו-foodType

`treatments.carbs > 0`. דה-דופליקציה לפי מפרט 7.1 (5 דקות, <20%). `foodType` ישיר. `protein`/`fat` קיימים בסכימה; `fiber` ו-`absorptionTime` נקראים אם קיימים.

### 5.5 הגדרות טיפול (צילום, מפרט 6.2 שלב 3)

מ-`profile.store[activeProfile]`: `basal[]`, `sens[]`, `carbratio[]` עם `timeAsSeconds` → `startTime`, `dia` → DIA. `sens` מומר ל-mg/dL אם `units === 'mmol'` (× 18.018). **סוג אינסולין:** Loop מעלה `insulinType` על טיפולי בולוס; נלקח הערך השכיח ב-7 הימים האחרונים, אחרת `Unknown`. פרופיל AAPS מספק `insulinType` ישירות אם קיים בפרופיל.

### 5.6 מצב חי (Ask Loopy, מפרט 9.5 בלוק 4)

מ-`devicestatus` האחרון שמכיל `loop`, דרך `lib/client-core/devicestatus/loop.js` (`selectLoopState`) כדי לא לשכפל לוגיקה:

| שורה בפרומט | שדה |
|---|---|
| IOB | `loop.iob.iob` |
| COB | `loop.cob.cob` |
| Loop Mode | `Closed Loop` אם ל-`loop.enacted` יש `received: true` ב-30 הדקות האחרונות, אחרת `Open Loop`. סוג הדוזינג: `loop.automaticDoseRecommendation.bolusVolume` קיים → `Automatic Bolus`, אחרת `Temp Basal Only` |
| Active Override | `override.active`, `override.name`, `override.multiplier`, `override.currentCorrectionRange.{minValue,maxValue}`, `override.duration`, `override.timestamp` |
| Last Loop | `loop.timestamp` |
| Current Delivery | `loop.enacted.rate` לעומת `profile.getBasal(now)` |
| Predicted | `loop.predicted.values[0]`, `[6]` (30 דקות), האחרון עם זמן `startDate + 5·n` |
| Pump Battery / Reservoir | `pump.battery.percent`, `pump.reservoir` |

ל-AAPS/Trio: `openaps.iob.iob`, `openaps.suggested.COB`, `openaps.enacted.rate`, `openaps.suggested.predBGs.IOB`. שתי המשפחות ממופות לאותה מבנה ביניים, והפרומט מתאים את השורה `**System**` (6.5) ל-`Loop` / `AAPS` / `Trio` / `oref0` לפי `devicestatus.device` ו-`loop.name`.

### 5.7 Meal Debrief: צילום התחזית (מפרט 7.5)

ב-iOS נלכד "צילום תחזית של Loop בזמן רישום הארוחה". ב-Nightscout הצילום הזה כבר קיים: ה-`devicestatus` הראשון עם `loop.predicted` ש-`created_at` שלו בין זמן הארוחה לבין 10 דקות אחריה. `predicted.values` בקפיצות 5 דקות → נדגם כל 30 דקות עד 240 לפרומט. אין צורך באחסון חדש. ארוחה ללא צילום כזה אינה זכאית ל-debrief, כמו במקור.

### 5.8 קפאין ואלכוהול (מפרט 6.6.5–6.6.6)

נרשמים כ-`treatments`:

```json
{ "eventType": "Caffeine", "created_at": "...", "caffeineMg": 142, "notes": "Coffee (med)", "enteredBy": "aiinsights" }
{ "eventType": "Alcohol",  "created_at": "...", "drinks": 1.5, "notes": "Beer (Craft/IPA)", "enteredBy": "aiinsights" }
```

הפלאגין חושף אותם ב-Careportal דרך `getEventTypes` עם ה-presets מהמפרט (Coffee sm 95, med 142, lg 190, Espresso 63, Tea Green 28, Tea Black 47, Cola 34, Energy Drink 80; Beer Light 1.0, Regular 1.0, Craft 1.5, Wine 1.0, Spirits 1.5, Mixed 1.5, Cocktail 2.0). מודל הדעיכה (מחצית חיים 5.7 שעות) והמטבוליזם הליניארי (משקה לשעה) ממומשים ב-`analyzers.js` כלשונם.

### 5.9 ביומטריה (שלב 5, אופציונלי)

אוסף `activity` מקבל `{ type: 'heartrate', created_at, heartrate }` ו-`{ type: 'steps', steps }` ממעלים כמו xDrip+ ו-Garmin. אם קיימים ≥ 50 מדגמי HR בחלון, בלוק `Biometric Context` ייבנה עם HR ו-Steps בלבד. HRV, שינה, משקל ומחזור נשארים מחוץ להיקף עד שיהיה מקור.

---

## 6. מודל נתונים: אוספים חדשים

כל האוספים נכתבים דרך `purifyForStorage(ctx, docs)` כמו שאר השרת. כל הערכים הגלוקוזיים ב-mg/dL.

### 6.1 `ai_suggestions`

מקביל ל-`SuggestionStore`. רשומה אחת לכל הצעה ממוזגת (אחרי מיזוג 6.7 שלב 7).

```json
{
  "_id": "ObjectId",
  "record_id": "uuid-v4",
  "created_at": "2026-10-10T08:12:00.000Z",
  "analysis_id": "ObjectId of ai_analyses",
  "setting_type": "basal_rate | carb_ratio | insulin_sensitivity",
  "period_days": 14,
  "time_blocks": [ { "start_seconds": 0, "end_seconds": 21600, "current_value": 0.8, "proposed_value": 0.85 } ],
  "plain_summary": "…",
  "reasoning": "…",
  "confidence": "low | medium | high",
  "success_criteria": {
    "expected_outcomes": ["…"], "evaluation_days": 5,
    "revert_warnings": ["…"], "metric_targets": { "overnight_avg": "<130 mg/dL" }
  },
  "validation_notes": ["clamped basal 00:00-06:00 from +18% to +15%", "citation 162 not found in hourly averages"],
  "status": "pending | applied | dismissed | reverted | superseded",
  "status_changed_at": "…",
  "applied_at": null,
  "evaluation": null,
  "profile_snapshot_id": "profile _id at analysis time"
}
```

- `evaluation` מתמלא מ-`past_suggestion_evaluations` של ניתוח מאוחר: `{ criteria_met, criteria_total, verdict, reasoning, evaluated_at, analysis_id }`.
- `superseded`: הצעה `pending` קודמת לאותו `setting_type` כאשר ניתוח חדש נכנס (מפרט 6.2 שלב 8).
- אינדקסים: `{ setting_type: 1, status: 1, created_at: -1 }`, `{ record_id: 1 }` ייחודי.

### 6.2 `ai_analyses`

תוצאת כל קריאת AI, גם לצורך מטמון (Trends לכל לשונית, Debrief לכל ארוחה) וגם לתיעוד.

```json
{
  "_id": "ObjectId",
  "kind": "settings | trends | chat | meal_advice | pre_meal | debrief | connection_test",
  "created_at": "…",
  "job_id": "uuid",
  "input": {
    "period_days": 14, "setting_type": "basal_rate", "tab": "weekly",
    "meal_treatment_id": "…", "food_type": "…",
    "window": { "from": "…", "to": "…" }
  },
  "aggregate_snapshot": { "tir": 78.2, "tbr": 2.1, "cv": 34.0, "gmi": 6.9, "avg": 148, "tdd": 41.2, "patterns": [], "score": { "total": 82, "grade": "B" } },
  "prompt_chars": { "system": 9800, "user": 6200 },
  "response_text": "raw text (sanitized before render)",
  "parsed": { "…": "kind-specific" },
  "overall_assessment": "…",
  "next_recommended_focus": "carb_ratio | insulin_sensitivity | basal_rate | null",
  "provider": { "format": "anthropic", "model": "claude-sonnet-4-5-20250514", "latency_ms": 18340, "http_status": 200 },
  "usage_id": "ObjectId of ai_usage",
  "error": null
}
```

- `chat` נשמר ללא `response_text`/`parsed` כברירת מחדל (רק מטא-נתונים ועלות). שיחה אינה היסטוריה רפואית ואינה נשמרת, כמו באפליקציה.
- TTL: אינדקס `expireAfterSeconds` של 180 יום על `created_at` לסוגים `chat`, `trends`, `connection_test`. `settings` ו-`debrief` נשמרים ללא TTL כי דוח Endo ו-"Past Suggestion Evaluation" תלויים בהם.

### 6.3 `ai_usage`

ספר חשבונות לתקציב (מפרט 3.6).

```json
{ "created_at": "…", "kind": "settings", "model": "gpt-4o",
  "estimated_input_tokens": 4000, "estimated_output_tokens": 900,
  "reported_input_tokens": 4211, "reported_output_tokens": 871,
  "estimated_cost_usd": 0.019, "month": "2026-10" }
```

`reported_*` נלקחים מהתשובה כשקיימים (`usage.prompt_tokens`, `usage.input_tokens`, `usageMetadata.promptTokenCount`), אחרת `chars / 4`. סכום החודש = `aggregate({ $match: { month } }, { $group: { $sum } })`.

### 6.4 `ai_settings`

ראו 4.3. מסמך יחיד `_id: 'default'`.

---

## 7. REST API והרשאות

### 7.1 מדוע מחרוזות הרשאה בנות 4 חלקים

התפקיד `readable` (ברירת מחדל לקוראים אנונימיים ברוב ההתקנות) מחזיק `*:*:read`. ב-shiro-trie מחרוזת בת 3 חלקים כזו **אינה** תואמת למחרוזת בת 4 חלקים. לכן `api:aiinsights:suggestions:read` אינו נגיש לאנונימיים, בעוד `api:aiinsights:read` היה נגיש. כל ההרשאות כאן בנות 4 חלקים, כדי שתובנות קליניות וצ'אט על נתוני PHI לא ייחשפו למי שיש לו רק גישת צפייה למסך.

### 7.2 הרשאות ותפקידים

| הרשאה | מה מתירה |
|---|---|
| `api:aiinsights:suggestions:read` | קריאת הצעות, ניתוחים, ציון, דפוסים, דוח |
| `api:aiinsights:suggestions:update` | שינוי סטטוס הצעה (applied/dismissed/reverted) |
| `api:aiinsights:analyze:create` | הפעלת ניתוח, Trends, Meal, Debrief (עולה כסף) |
| `api:aiinsights:chat:create` | Ask Loopy |
| `api:aiinsights:careportal:create` | רישום Caffeine/Alcohol (בפועל נכתב ל-treatments, אך דרך ה-router הזה) |
| `api:aiinsights:settings:read` | קריאת `ai_settings` ושימוש חודשי |
| `api:aiinsights:settings:update` | כתיבת `ai_settings`, בדיקת חיבור |

תפקיד ברירת מחדל חדש ב-`lib/authorization/storage.js`:

```js
{ name: 'ai-insights', permissions: [ 'api:aiinsights:suggestions:read', 'api:aiinsights:suggestions:update'
  , 'api:aiinsights:analyze:create', 'api:aiinsights:chat:create', 'api:aiinsights:careportal:create'
  , 'api:aiinsights:settings:read' ] }
```

`admin` (`*`) ובעל `API_SECRET` מקבלים הכול, כולל `settings:update`. ההמלצה ב-README: ליצור subject עם התפקידים `readable` + `careportal` + `ai-insights` ולהשתמש ב-token שלו בדפדפן.

**הכרעה: התפקיד `readable` לעולם אינו מקבל גישה ל-AI Insights.** זו אינה רק המלצה אלא אכיפה:

1. אף הרשאת `api:aiinsights:*` אינה מתווספת לתפקידי ברירת המחדל `readable`, `status-only`, `careportal`, `devicestatus-upload`, `activity`.
2. בעלייה, `lib/aiinsights/index.js` בודק את `AUTH_DEFAULT_ROLES` ואת הרשאות התפקידים שבהם. אם תפקיד ברירת מחדל (זה שמוענק לבקשות ללא credential) מחזיק `ai-insights`, `api:aiinsights:*`, או `*`, התכונה נטענת במצב **locked**: כל נקודות הקצה פרט ל-`GET /settings` (שמחזיר `{ locked: true, reason }`) מחזירות `403`, ונרשם `adminnotifies` בולט. מופע Nightscout "פתוח" (`AUTH_DEFAULT_ROLES=admin`, נפוץ בהתקנות ישנות) לא יחשוף תובנות קליניות וצ'אט על PHI לאינטרנט.
3. `PUT /api/v2/authorization/roles` אינו נחסם (זה מחוץ לפלאגין), אבל `reload()` של ההרשאות מפעיל את אותה בדיקה מחדש, כך שהוספת ההרשאה לתפקיד ברירת מחדל בזמן ריצה נועלת את התכונה מיד.
4. בדיקה AI-API-003 מוודאת ש-`readable` מקבל `401` על כל נקודת קצה, ו-AI-API-004 מוודאת את מצב locked.

### 7.3 נקודות קצה

כולן תחת `/api/v1/aiinsights`. גוף JSON. שגיאות בפורמט `wares.sendJSONStatus`.

| Method | Path | הרשאה | תיאור |
|---|---|---|---|
| `GET` | `/settings` | settings:read | `ai_settings` ממוזג עם env (ללא מפתח), `providerConfigured: bool`, `privacyAck: bool` |
| `PUT` | `/settings` | settings:update | עדכון חלקי. אימות לפי 4.3 |
| `POST` | `/settings/test-connection` | settings:update | מפרט 3.5. מחזיר `{ ok, httpStatus, latencyMs, message }` |
| `GET` | `/usage?month=YYYY-MM` | settings:read | `{ month, estimatedCostUsd, callCount, capUsd, warnPercent, percentUsed, blocked }` |
| `GET` | `/aggregate?period=14` | suggestions:read | `AggregatedData` + `patterns` + `score` ללא AI. משמש ללשונית Stats ולכרטיסי המדדים |
| `POST` | `/analyze` | analyze:create | גוף: `{ settingType: 'basal_rate' \| 'carb_ratio' \| 'insulin_sensitivity' \| 'all', period: 14, confirmCost: true }`. מחזיר `202 { jobId, estimatedCostUsd }` או `402` אם התקציב חוסם |
| `POST` | `/trends` | analyze:create | `{ tab: 'daily' \| 'weekly' \| 'monthly', refresh: false }`. אם קיים ניתוח מטמון ו-`refresh=false` מחזיר `200` עם התוצאה; אחרת `202 { jobId }` |
| `POST` | `/chat` | chat:create | `{ message, history: [{role, content}] }` (עד 10). מחזיר `202 { jobId }` |
| `GET` | `/meals?period=14` | suggestions:read | אירועי ארוחה (7.2) + דפוסי foodType (7.1) ללא AI |
| `POST` | `/meals/advice` | analyze:create | `{ foodType }` → `202` |
| `POST` | `/meals/pre-meal` | analyze:create | `{ foodType }` → `200` עם הסיכום הלוקלי מיידית + `jobId` להעשרה |
| `POST` | `/meals/:treatmentId/debrief` | analyze:create | `202` או `200` מהמטמון. `409` אם הארוחה בת פחות משעתיים או אין צילום תחזית |
| `GET` | `/jobs/:jobId` | suggestions:read | `{ status: 'queued' \| 'running' \| 'done' \| 'failed', progress: 'basal_rate 1/3', result?, error? }` |
| `GET` | `/suggestions?status=pending&settingType=` | suggestions:read | רשימה |
| `PATCH` | `/suggestions/:recordId` | suggestions:update | `{ status: 'applied' \| 'dismissed' \| 'reverted' }`. `applied` מצלם `profile._id` נוכחי |
| `GET` | `/analyses?kind=settings&limit=10` | suggestions:read | היסטוריה |
| `GET` | `/report.pdf?period=14&sections=glucose,insulin,...` | suggestions:read | דוח Endo (10.2) כ-PDF A4. `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="LoopInsights_Report_yyyy-MM-dd_HHmmss.pdf"`. ראו 9.7 |
| `GET` | `/report.json?period=14` | suggestions:read | אותם נתונים (`ReportData`) כ-JSON, לתצוגה מקדימה בלשונית Report ולמחקר |
| `POST` | `/careportal` | careportal:create | `{ kind: 'caffeine' \| 'alcohol', preset?, amount?, created_at? }` → נכתב ל-`ctx.treatments.create` |

### 7.4 תור העבודות (`jobs.js`)

- מפה בזיכרון `jobId → { kind, status, startedAt, result, error }`. אין צורך ב-Redis: Nightscout הוא תהליך יחיד.
- **concurrency = 1** לקריאות LLM. בקשות נוספות נכנסות לתור. מניעת כפל: `POST /analyze` עם אותם פרמטרים כשיש job פעיל מחזיר את ה-`jobId` הקיים.
- תוצאה נשמרת ב-`ai_analyses` לפני ש-`status` הופך ל-`done`, כך שריסטארט של השרת לא מאבד תוצאה שהושלמה. job שאבד בריסטארט מוחזר כ-`failed` עם `error: 'server restarted'`.
- TTL של רשומות job בזיכרון: 15 דקות אחרי סיום.
- Timeouts: `AbortController` 60 שניות לבקשה, 120 שניות לכל ה-job (מפרט 3.1).

### 7.5 הגבלת קצב

ללא תלות חדשה. מגביל חלון-הזזה בזיכרון ב-`lib/api/aiinsights/ratelimit.js`:

| נתיב | מגבלה |
|---|---|
| `POST /analyze` | 6 לשעה |
| `POST /trends`, `/meals/*` | 20 לשעה |
| `POST /chat` | 30 ל-10 דקות |
| `POST /settings/test-connection` | 10 לשעה |
| `GET /report.pdf` | 10 לשעה (יצירת PDF היא CPU-bound) |

מעבר למגבלה: `429` עם `Retry-After`. המפתח למגבלה הוא ה-subject (מה-JWT) או ה-IP.

---

## 8. מתאם ספק ה-AI

`lib/aiinsights/provider.js`. מימוש מפרט 3.1–3.5 במלואו.

### 8.1 תצורה אפקטיבית

```js
function effectiveConfig (env, settings) {
  const baseUrl = settings.baseUrl || env.extendedSettings.aiinsights.baseUrl || 'https://api.openai.com/v1';
  const format = settings.requestFormat || detectFormat(baseUrl);   // 3.2
  return {
    baseUrl, format
    , model: settings.model || 'gpt-4o'
    , endpointPath: settings.endpointPath || DEFAULT_PATH[format]
    , apiKeyHeader: DEFAULT_KEY_HEADER[format]
    , apiKeyPrefix: DEFAULT_KEY_PREFIX[format]
    , maxTokens: 8192          // enforced min and max, spec 3.1
    , temperature: 0.0         // always, spec 3.1
    , apiVersion: settings.apiVersion || null
    , organizationId: settings.organizationId || null
  };
}
```

`detectFormat`: `anthropic.com` → `anthropic`; `googleapis.com` או `generativelanguage` → `gemini`; אחרת `openai`.

### 8.2 בניית הבקשה

גופי הבקשה שלושתם כלשונם במפרט 3.3, כולל `cache_control: { type: 'ephemeral' }` על ה-system של Anthropic, `anthropic-version: 2023-06-01`, ו-`?key=` עבור Gemini בנוסף לכותרת `x-goog-api-key`. Gemini `generationConfig`: `topP 0.95`, `topK 8`. Azure: `?api-version=`. OpenAI: `OpenAI-Organization`.

נתיב Gemini: `endpointPath.replace('{MODEL}', model)`.

### 8.3 שליחה

```js
async function sendPrompt (cfg, apiKey, systemPrompt, userPrompt, { maxTokens, signal }) {
  const { url, headers, body } = buildRequest(cfg, apiKey, systemPrompt, userPrompt, maxTokens || cfg.maxTokens);
  assertUrlAllowed(url, env);                      // 11.2
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ProviderError(res.status, summarizeError(json));
  return { text: extractText(cfg.format, json), usage: extractUsage(cfg.format, json), status: res.status };
}
```

`extractText` לפי מפרט 3.4 בסדר: (1) Gemini: החלק האחרון ב-`parts` שאינו `thought: true`, ואם אין כזה ו-`usageMetadata.thoughtsTokenCount > 0` → `EmptyThinkingResponse`; (2) נתיב המפתח של הפורמט; (3) חיפוש עומק של כל `text`, עדיפות למחרוזת המכילה `suggestions` או `{`, אחרת הארוכה ביותר; (4) כל ה-JSON כמחרוזת.

### 8.4 בדיקת חיבור

system `You are a test.`, user `Reply with exactly: OK`, `maxTokens = 128`. סטטוסים 402 ו-429 נחשבים הצלחה (המפתח תקין).

### 8.5 עלות ותקציב (`usage.js`)

טבלת המחירים מהמפרט 3.6 כלשונה, לפי התאמת מחרוזת בשם המודל, ברירת מחדל 3/15. אומדן לפני קריאה: הגדרה אחת 0.07, שלוש 0.21, אחר 0.02 דולר.

`budgetGate(kind, settingCount)`:
1. אם `monthlyCapUsd === 0` → עובר.
2. `spent = sum(ai_usage[month])`. אם `spent + estimate > cap` ו-`hardBlock` → `402 { reason: 'budget_exceeded' }`.
3. אם `spent / cap ≥ warnPercent / 100` → התשובה ל-`POST` כוללת `warning: 'budget_warning'`.
4. אם `confirmBeforeCall` ו-`confirmCost !== true` בגוף הבקשה → `409 { requiresConfirmation: true, estimatedCostUsd }`. ה-UI מציג דיאלוג "אשר / אשר לכל ההפעלה" (האחרון נשמר ב-`sessionStorage` של הדפדפן).

---

## 9. זרימות עבודה

### 9.1 ניתוח הגדרות (מפרט 6.2)

```
POST /analyze { settingType, period }
 1. budgetGate                                     (6.2.1)
 2. aggregate(from, to) once                        (6.2.2)  aggregator.js
 3. captureTherapySnapshot(profile at `to`)         (6.2.3)
 4. buildSupplementalContext(agg, settings)         (6.2.4)  context.js, blocks per 6.6
 5. recentChanges = ai_suggestions{status:applied, applied_at ≥ now-24h,
      proposed still equals current profile value}  (6.2.5)
 6. pastOutcomes = up to 3 applied in 30d with success_criteria
      and evaluation == null; per record: hourly avgs since applied_at,
      only hours inside its time_blocks               (6.2.6)
 7. for each type in [basal_rate, carb_ratio, insulin_sensitivity]  (6.2.7)
      system = prompts/settings.systemPrompt(units, personality)
      user   = prompts/settings.userPrompt({...})
      text   = provider.sendPrompt(...)
      parsed = validator.parseSettingsResponse(text, type, snapshot, agg)
      store ai_analyses; job.progress = `${type} ${i}/${n}`
 8. write evaluations into past records; mark previous pending of
      same type as 'superseded'; insert new suggestions     (6.2.8)
 9. patterns = detectPatterns(agg); score = settingsScore(agg)  (6.2.9)
10. job.result = { analyses, suggestions, patterns, score }
```

סדר הריצה במצב `all`: `basal_rate → carb_ratio → insulin_sensitivity`, כסדר ההכרזה במקור (המפרט מציין שההערה בקוד אומרת אחרת; אנו משמרים את ההתנהגות בפועל). focus ברירת מחדל: `basal_rate`.

**User prompt (6.5):** נבנה בסדר ובכותרות הקבועות. הבדלים מהמקור, כולם מתועדים ב-`prompts/settings.js`:
- שורת `**System**` לפי מערכת הלולאה שזוהתה (5.6).
- בלוק `Biometric Context` מושמט אם אין נתוני `activity`.
- `Supplemental Analysis Context` ללא בלוקי Nightscout Data, MFP, FoodFinder, Correction Patterns (1.3).
- בלוק `USER ENGAGEMENT & ADHERENCE` תמיד: logging rate = carb treatments / (days × 3); corrections/day; applied/reverted/dismissed מתוך 10 ההצעות האחרונות ב-`ai_suggestions`.

### 9.2 Trends (מפרט 9)

לשוניות: Daily 3 ימים, Weekly 7, Monthly 30, Stats 7 (ללא AI). מטמון: `ai_analyses{kind:'trends', input.tab}` האחרון, תקף עד `refresh: true` או עד שעובר יום קלנדרי (הרחבה קטנה: באפליקציה המטמון חי עד רענון ידני, אבל בשרת רב-לקוחות המטמון חייב להתיישן מעצמו). הפענוח לפי 9.3: `SUMMARY`/`HIGHLIGHTS`, שורות `-`, ואם שניהם ריקים כל התשובה היא הסיכום. צבעי השבבים לפי 9.3 ממומשים בלקוח.

### 9.3 Ask Loopy (מפרט 9.5)

ההיסטוריה נשלחת מהלקוח בכל הודעה (עד 10) ואינה נשמרת בשרת. הקשר `DATA` נבנה בכל הודעה:
1. `CURRENT GLUCOSE (REAL-TIME)` מ-`ctx.ddata.sgvs` (כבר בזיכרון, 3 שעות אחרונות, דגימה כל ~25 דקות).
2. `buildTherapyContext(period)` במטמון 5 דקות בזיכרון, ואחריו `LAST 7 DAYS` עם 24 ממוצעים שעתיים ליום, בולוסים ופחמימות.
3. `buildSupplementalContext`.
4. `LIVE LOOP STATUS` (5.6).

### 9.4 Meal Insights (מפרט 7)

- `GET /meals`: עד 20 ארוחות אחרונות עם ציר גלוקוז 4 שעות, התאמת בולוס בחלון −5..+15 דקות, CR אפקטיבי = carbs / insulin. דפוסי foodType לפי 7.1.
- `POST /meals/advice`: פרומט 7.3 כלשונו.
- `POST /meals/pre-meal`: תנאי 2 ארוחות לפחות עם `foodType` שמכיל/מוכל במחרוזת. סיכום לוקלי מיידי בנוסח 7.4, ואז העשרת AI. debriefs אחרונים לאותו מזון מ-`ai_analyses{kind:'debrief'}`.
- `POST /meals/:id/debrief`: תנאי 5.7. פרומט 7.5. פענוח `LEARNINGS:` וביטויי "פחמימות אפקטיביות" כלשונם.

### 9.5 ניטור רקע (מפרט 6.11)

`monitor.js` נרשם ל-`ctx.bus.on('tick')` (כדקה). בכל tick:
1. `monitor.enabled` ויש מפתח ו-`privacyAck`.
2. `now − lastRunAt ≥ frequency` (`lastRunAt` נשמר ב-`ai_settings.monitor.lastRunAt`).
3. לא בשעות שקט (לפי אזור הזמן של הפרופיל).
4. אין job פעיל.
→ מפעיל `analyze('all', analysisPeriod)` דרך אותו תור. בסיום, הצעות עם `confidence ≥ minConfidence` מפעילות `sbx.notifications.requestNotify({ level: WARN, title: 'AI Insights: new suggestion', message: plain_summary, group: 'AI Insights', plugin })` מתוך `checkNotifications` של הפלאגין במחזור הבא. `notificationStyle: silent` מדלג על ההתראה ומשאיר רק את ה-pill.

### 9.6 Pill בלוח הראשי

`setProperties` מציע `aiinsights` property: `{ pending: n, lastAnalysisAt, score }` שנטען מ-`/api/v1/aiinsights/suggestions?status=pending` בלקוח (לא דרך `sbx.data`, כי הדאטה-לודר אינו טוען אוספים אלה). `updateVisualisation`: `updatePillText(plugin, { label: 'AI', value: pending > 0 ? pending + ' new' : grade, info: [...] })`. לחיצה מנווטת ל-`/insights`.

### 9.7 דוח Endo (PDF, מפרט 10)

**מדוע `pdfmake`.** המאגר לא מכיל ספריית PDF. האפשרויות שנשקלו:

| אפשרות | הכרעה | סיבה |
|---|---|---|
| `puppeteer` / headless Chromium | נדחה | ~300MB, לא עובד ב-dyno של Heroku/Railway, זמן אתחול ארוך |
| `pdfkit` ישיר | נדחה | ציור ידני של כל טבלה וכרטיס; הרבה קוד פריסה |
| `pdfmake` (מעל `pdfkit`) | **נבחר** | JavaScript טהור, ללא בינארי; הגדרת מסמך הצהרתית (טבלאות, עמודות, `canvas` למלבנים צבעוניים); תומך ב-14 הגופנים הסטנדרטיים של PDF (Helvetica) בלי לצרף קובצי TTF; מספר תלויות-משנה קטן |
| jsPDF בדפדפן | נדחה | אינו מאפשר ייצור בשרת לצורך שליחה בדוא"ל בעתיד, ומוסיף ~400KB ל-bundle הלקוח |

ההצדקה לפי `CONTRIBUTING.md`: תלות אחת, ללא native build, `npm audit` נקי בגרסה הנוכחית, נטענת עצלה (`require` בתוך ה-handler) כך שאינה משפיעה על זמן העלייה או על bundle הלקוח.

**זרימה.**

```
GET /report.pdf?period=14&sections=...
 1. report.collect(period, sections) → ReportData
      aggregate(period)                     glucose / insulin / carbs
      ai_suggestions{status:applied, 10 latest} + evaluation   settings changes
      detectPatterns(agg)                    AI insights
      analyzers.caffeine/alcohol(period)     if entries exist
      analyzers.negativeBasal(period)        pump suspensions
      activity HR/steps                      only if phase 5 data exists
 2. report-pdf.build(ReportData) → pdfmake docDefinition
 3. printer.createPdfKitDocument(def) → stream → res
```

**מבנה המסמך (מפרט 10.2, אחד לאחד).**

- `pageSize: 'A4'`, `pageMargins: [36, 36, 36, 36]` (595.28 × 841.89 נק').
- כותרת: `LoopInsights` / `Endocrinologist Visit Report` / `Automated Insulin Delivery Performance Summary` / `{start} — {end} ({period})`. רקע: מלבן `canvas` במילוי `#1a8a9e` (pdfmake אינו תומך בגרדיאנט; צבע אחיד מהקצה הכהה של הגרדיאנט המקורי, `#14707e` כפס תחתון דק).
- **Glucose Summary**: שישה כרטיסים ב-`columns` (TIR מודגש, GMI, Average, SD, CV, Readings). עמודת TIR אנכית: `canvas` של חמישה מלבנים בגובה יחסי, מלמעלה: `#C14F0C`, `#F0CA4C`, `#74A52E`, `#D36265`, `#7F0302`, עם התוויות `{0}% Very High` … `{0}% In Tight Range` (ב-`#1a8a9e`). כותרת תחתית `Target Range: 70-180 mg/dL`, `Tight Range: 70–{tightUpper}`.
- **Glucose by Time of Day**: טבלה של שישה דליים (Night 0–3, Early AM 4–7, Morning 8–11, Afternoon 12–15, Evening 16–19, Late 20–23) עם `fillColor`/`color` לפי הממוצע: <70 `#ffe0e0`/`#cc0000`; >180 `#fff3e0`/`#cc6600`; אחרת `#e8f8e8`/`#1a7a2e`.
- **Insulin Delivery**: כרטיסי Avg TDD, Basal %, Bolus %. טבלה: Correction Boluses, TDD Range, TDD CV, Week-over-Week (אם קיים).
- **Nutrition & Meals**: Daily Carbs, Meals Logged, Per Meal Avg.
- **Settings Changes Applied**: עד 8 הצעות שיושמו, `{settingType} — {date}`, תיאור, תג תוצאה בצבעי `outcome-success` ירוק, `outcome-partial` כחול, `outcome-none` כתום, `outcome-worsened` אדום, או `Awaiting evaluation`.
- **Activity & Biometrics**: רק אם יש נתוני `activity` (שלב 5). אחרת הסעיף מושמט.
- **Engagement & Compliance**: Applied / Dismissed / Reverted, Acceptance Rate, Carb Entries.
- **Caffeine & Alcohol**: רק אם יש רשומות בתקופה.
- **Pump Suspensions & Sub-Basal**: רק אם חושב `negativeBasalStats`.
- **AI Insights**: Detected Patterns בצבעי חומרה (`#dc2626`, `#d97706`, `#2563eb`) עם `({High|Medium|Low} confidence)`. Behavior Correction Patterns מושמט (1.3).
- כותרת תחתית בכל עמוד (`footer` function): `LoopInsights — AI-Powered Therapy Settings Analysis`, ה-disclaimer המלא, ו-`Generated: {date} • Report Period: {period} • Readings: {n}`.

כל הערכים ב-mg/dL. `sections` בשאילתה מסננים סעיפים; ברירת מחדל: כולם, כמו במפרט 10.1. `Content-Disposition` עם שם הקובץ מהמפרט. הדוח הבסיסי (10.3) ממומש כ-`?variant=basic`: שלוש טבלאות בלבד ללא מיתוג.

**ביצועים.** יצירת PDF של 2–3 עמודים אורכת ~100–300 ms. סינכרוני לחלוטין מלבד שליפת הנתונים, ולכן אינו עובר דרך תור העבודות. מוגבל ל-10 לשעה (7.5).

---

## 10. שכבת האימות והבטיחות

`validator.js`. ממומש במלואו, בסדר הזה, לכל תשובת ניתוח הגדרות (מפרט 6.7):

| # | שלב | מימוש |
|---|---|---|
| 1 | חילוץ JSON | בלוק ```` ```json ````, אחרת ```` ``` ````, אחרת מ-`{` הראשון עד `}` האחרון |
| 2 | תיקון JSON קטוע | הסרת מפתח-ערך חלקי אחרי הפסיק האחרון, סגירת מחרוזת, סגירת `]`/`}` חסרים |
| 3 | זיהוי מעטפת API | מפתחות `candidates`/`usageMetadata` → `EmptyThinkingResponse` |
| 4 | שדות חובה ועיגול | `time_blocks`, `reasoning`, `confidence ∈ {low,medium,high}`. עיגול: CR 0.1, Basal 0.05, ISF שלם |
| 5 | סינון בלוקים | מחוץ לגבול מוחלט → נדחה; מחוץ למומלץ → אזהרה; שינוי > 25% (CR/ISF) או > 15% (Basal) → נדחה; proposed == current מעוגל → no-op |
| 6 | success_criteria | `evaluation_days` ברירת מחדל 5; נשמר רק עם `expected_outcomes` |
| 7 | מיזוג | כל ההצעות לאותו סוג → אחת: בלוקים ממוינים, הביטחון הגבוה, reasoning מחובר, success_criteria ו-plain_summary הראשונים שאינם ריקים |
| 8 | Clamp | בלוק שחרג מהסף אך לא יותר מפי 1.5 ממנו מכווץ לסף + `validation_notes` |
| 9 | ציטוטים | מספרים 40–400 ב-reasoning לפי `NNN mg/dL`, `glucose … NNN`, `average … NNN` מול ממוצעים שעתיים ±2 → `validation_notes` |
| 10 | תקרת ביטחון | CR עם < 5 ארוחות או ISF עם < 3 תיקונים → `low` + אזהרה ב-reasoning |
| 11 | סתירה | reasoning מכיל אחד מ-14 הביטויים (`cannot be derived`, `insufficient data`, `no meal data`, …) וביטחון ≠ low → ההצעה מוסרת |

גבולות (`guardrails`, מפרט 6.8):

| הגדרה | מינ' מוחלט | מינ' מומלץ | מקס' מומלץ | מקס' מוחלט |
|---|---|---|---|---|
| Carb Ratio (g/U) | 2.0 | 4.0 | 28.0 | 150.0 |
| ISF (mg/dL/U) | 10.0 | 16.0 | 400.0 | 500.0 |
| Basal (U/hr) | 0.05 | 0.05 | 10.0 | 30.0 |

כיוון שאין יישום אוטומטי ב-Nightscout, הכלל "יישום אוטומטי נחסם מחוץ למומלץ" מתורגם ל: הצעה מחוץ לטווח המומלץ מוצגת עם תג אזהרה בולט ואינה ניתנת לסימון `applied` בלי אישור נוסף בדיאלוג.

**כל כשל בשלבים 1–3 מחזיר `{ suggestions: [], past_suggestion_evaluations: {}, error }`**, לעולם לא תוצאה חלקית.

---

## 11. אבטחה ופרטיות

### 11.1 המפתח

- נקרא ב-`env.js` ל-`env.enclave.setAiApiKey()`, ו-`process.env.AIINSIGHTS_API_KEY` נמחק מיד. תמיכה ב-`_FILE` כמו `API_SECRET_FILE`.
- אינו נכנס ל-`env.settings`, ל-`extendedSettings`, ל-`/api/v1/status.json`, ללוג, או ל-Mongo. `GET /settings` מחזיר `providerConfigured: true` בלבד.
- `'apiKey'` מתווסף ל-`secureSettings` כהגנת עומק.
- מפתח דרך UI (שלב עתידי): אם יוחלט לאפשר, הוא יישמר ב-`ai_settings` מוצפן ב-AES-256-GCM עם מפתח נגזר מ-`API_SECRET` (SHA512 שכבר נמצא ב-enclave). לא בשלב 1.

### 11.2 SSRF

`baseUrl` ניתן לשינוי ע"י אדמין, ולכן `assertUrlAllowed`: `https:` בלבד; DNS resolve של ה-host; חסימת `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7` אלא אם `AIINSIGHTS_ALLOW_PRIVATE_URL=true` (למודלים מקומיים). אין redirect-follow (`redirect: 'error'`).

### 11.3 XSS בפלט המודל

כל `response_text`, `reasoning`, `plain_summary`, `overall_assessment`, highlights ותשובות צ'אט עוברים `sanitize-html` עם allowlist `['b', 'strong', 'em', 'ul', 'li', 'br', 'p']` לפני אחסון **וגם** לפני רינדור. Markdown `**bold**` מומר ל-`<strong>` בלקוח אחרי הניקוי. בהתאם לממצא NS-SEC-003 בביקורת האבטחה.

### 11.4 PHI לספק צד שלישי

הפעלת התכונה משמעה שליחת נתוני גלוקוז, אינסולין ופחמימות לספק חיצוני. נדרש:
- `AIINSIGHTS_PRIVACY_ACK=true` ב-env (אדמין), **וגם**
- אישור חד-פעמי בדף `/insights` שנשמר ב-`ai_settings.privacyAcknowledgedAt`.
בלי שניהם כל נקודות הקצה שעולות כסף מחזירות `403 { reason: 'privacy_ack_required' }`. README יסביר אילו נתונים נשלחים (הפרומטים המלאים מתועדים) ויפנה למדיניות הפרטיות של הספק הנבחר. שם המטופל, `enteredBy`, `device`, ו-`_id` לעולם אינם נכללים בפרומט.

### 11.5 לוגים

ברירת מחדל: `[aiinsights] kind=settings type=basal_rate status=200 latency=18340ms est_cost=0.019`. פרומטים ותשובות מלאים רק עם `AIINSIGHTS_DEBUG_PROMPTS=true`, ולעולם לא בייצור.

### 11.6 Disclaimer

כל מסך ודוח כולל את הטקסט מהמפרט 10.2: _"This report was automatically generated for informational purposes only. It is not a substitute for professional medical advice…"_. הצעות מסומנות `Advisory only`.

---

## 12. ממשק משתמש

### 12.1 דף `/insights`

נבנה באותו דפוס של `/report` ו-`/profile`: תבנית EJS, `bundle.app.js`, סקריפט init, jQuery. ללא framework חדש.

```
┌ AI Insights ───────────────────────────────── [⚙ Settings] [Auth] ┐
│ [Settings] [Trends] [Ask] [Meals] [Report]                        │
├───────────────────────────────────────────────────────────────────┤
│ Period: (3)(7)(14)(30)(90)   Score: 82 B   TIR 78% TBR 2.1% CV 34 │
│ [Analyze Basal] [Analyze CR] [Analyze ISF] [Analyze All]  ~$0.21  │
│ ── Pending suggestions ──────────────────────────────────────────  │
│ ▸ Basal Rate · medium · 12:00 AM–6:00 AM 0.80 → 0.85 U/hr         │
│   "I think you need a little more background insulin overnight…"  │
│   [Reasoning ▾] [Success criteria ▾] [Applied] [Dismiss]          │
│ ── Detected patterns ── Dawn Phenomenon (medium) · High CV (med)  │
│ ── Past evaluations ── 2026-10-02 CR 12:00 PM: partial (2/3)      │
└───────────────────────────────────────────────────────────────────┘
```

- **Settings tab:** הכול לעיל. `Applied` פותח דיאלוג: "שינית את ההגדרה ב-Loop/AAPS? Nightscout לא משנה הגדרות עבורך." ואז `PATCH status=applied`.
- **Trends tab:** Daily / Weekly / Monthly / Stats. שבבי מדדים בצבעי 9.3. כפתור Refresh. ה-Advisor פותח את לשונית Ask.
- **Ask tab:** צ'אט, היסטוריה ב-`sessionStorage`, כפתור "Clear".
- **Meals tab:** רשימת 20 ארוחות עם spark-line 4 שעות (D3 כבר קיים), טבלת foodType, כפתורי Advice / Debrief, קלט Pre-meal.
- **Report tab:** בחירת תקופה ומתגי סעיפים (10.1). תצוגה מקדימה של המספרים מ-`/report.json`. כפתור **Download PDF** → `GET /report.pdf?…` עם `client.headers()` דרך `fetch`, ואז `Blob` + `<a download>` (לא `window.open`, כדי שה-token יישלח בכותרת ולא ב-URL, לפי ממצא NS-SEC-001).
- **⚙ Settings:** כל שדות 4.3, שימוש חודשי, Test connection, Privacy acknowledgement. שדות ספק קריאה-בלבד אם מוגדרים ב-env.
- **Developer mode:** לחיצה ארוכה 3 פעמים על הכותרת (כמו במקור) חושפת "Show raw prompt / response".

### 12.2 יחידות

הכול ב-mg/dL, ללא תלות ב-`client.settings.units` או ב-`profile.units`. אם `client.settings.units === 'mmol'`, דף `/insights` מציג פס מידע קבוע: _"AI Insights displays glucose in mg/dL."_ הפרומט תמיד מכיל את גרסת mg/dL של `UNIT CONTEXT`. אין קוד המרה בלקוח. אם בעתיד תידרש תמיכה ב-mmol/L, נקודת החיבור היחידה היא `prompts/units.js` (בחירת הגרסה) ושכבת תצוגה בלקוח; שאר המערכת כבר mg/dL כמו במקור.

### 12.3 Careportal

שני סוגי אירוע חדשים, `Caffeine` ו-`Alcohol`, מופיעים בתפריט ה-Careportal הקיים דרך `plugin.getEventTypes`, עם רשימת presets ושדה כמות. נראים רק כש-`features.caffeineTracking`/`alcoholTracking` פעילים.

---

## 13. בדיקות

Mocha + should, לפי התבנית ב-`plugin-architecture-audit.md`. כל קובץ נוסף לרשימת `test:unit` ב-`package.json`.

| קובץ | מכסה | מזהים |
|---|---|---|
| `tests/aiinsights-aggregator.test.js` | 6.3: SD, CV, דליים, TITR, GMI, שעתיים; basal integrator עם Temp Basal/percent/suspend; TDD; תיקונים; דה-דופ פחמימות | AI-AGG-001..020 |
| `tests/aiinsights-analyzers.test.js` | 6.6.1–6.6.2, 6.6.5–6.6.7, 6.9 (כל 8 הדפוסים, שני הספים), 6.10 (כל רכיבי הציון וגבולות הציונים), 7.1 | AI-ANL-001..030 |
| `tests/aiinsights-prompts.test.js` | snapshot של system prompt 6.4 (שוויון מחרוזת מלא לטקסט המפרט); מבנה user prompt 6.5 עם/בלי בלוקים מותנים; UNIT CONTEXT תמיד mg/dL גם עם פרופיל mmol; 4 אישיויות; 9.1; 9.5; 7.3–7.5 | AI-PRM-001..015 |
| `tests/aiinsights-report.test.js` | `ReportData` מול fixtures; docDefinition: סדר הסעיפים, השמטת סעיפים ריקים, צבעי דליים ותגי תוצאה, שוליים ו-A4; ה-PDF שנוצר נפתח (`%PDF-` header, מספר עמודים ≥ 1); `variant=basic`; `Content-Disposition` | AI-RPT-001..012 |
| `tests/aiinsights-validator.test.js` | 11 שלבי 6.7 בנפרד; JSON קטוע; מעטפת Gemini; clamp 1.5×; ציטוטים; תקרת ביטחון; 14 ביטויי סתירה; מיזוג; 9.3 ו-7.5 parsing | AI-VAL-001..040 |
| `tests/aiinsights-provider.test.js` | detectFormat; 3 גופי בקשה (deep equal למפרט 3.3); extractText 4 השלבים כולל thought parts; test-connection עם 402/429; SSRF allowlist; `fetch` מדומה | AI-PRV-001..020 |
| `tests/aiinsights-usage.test.js` | טבלת מחירים (8 התאמות); budgetGate 4 מצבים; אומדנים | AI-USE-001..012 |
| `tests/aiinsights-api.test.js` (integration) | הרשאות: `readable` מקבל 401 על כל נקודת קצה; מצב locked כאשר `AUTH_DEFAULT_ROLES` מחזיק `ai-insights` או `admin`; `ai-insights` role; admin; 202/jobId flow; 402/403/409/429; PATCH סטטוס; settings validation; `/status.json` אינו מכיל מפתח | AI-API-001..027 |
| `tests/aiinsights-monitor.test.js` | תדירות, שעות שקט לפי אזור זמן, minConfidence, ללא job כפול | AI-MON-001..008 |
| `tests/plugins.test.js` (קיים) | מתעדכן אוטומטית: שם הקובץ = `plugin.name` | — |

חוזה ספק: fixtures של תשובות אמיתיות (מוסתרות) לכל פורמט, כולל תשובת Gemini עם `thought: true` ותשובה קטועה.

---

## 14. תכנית ביצוע בשלבים

| שלב | תוכן | קבצים עיקריים | תלות |
|---|---|---|---|
| **0. תשתית** | env + enclave, 4 אוספים + indexes, store, settings endpoint, provider + test-connection, usage + budget, jobs, router, הרשאות ותפקיד + בדיקת locked, rate limit, README | `env.js`, `enclave.js`, `aiinsights-store.js`, `provider.js`, `usage.js`, `jobs.js`, `api/aiinsights/`, `authorization/storage.js` | — |
| **1. Therapy Settings** | aggregator, basal integrator, snapshot, supplemental (circadian, negative basal, cgm quality, engagement), prompts 6.4/6.5, validator, patterns, score, `/analyze`, `/suggestions`, `/aggregate`, דף `/insights` עם לשונית Settings, pill | `aggregator.js`, `basal-integrator.js`, `analyzers.js`, `context.js`, `prompts/settings.js`, `validator.js`, `plugins/aiinsights.js`, `views/insightsindex.html`, `insightsclient.js` | 0 |
| **2. Trends + Ask** | therapy context 9.4, live status 5.6, prompts 9.1/9.5, מטמון trends, לשוניות Trends/Ask | `prompts/trends.js`, `prompts/chat.js`, `context.js` | 1 |
| **3. Meals + Careportal** | אירועי ארוחה, food response, advice, pre-meal, debrief מ-`devicestatus.predicted`, Caffeine/Alcohol event types + analyzers | `prompts/meal.js`, `analyzers.js` | 1 |
| **4. Monitor + Report** | ניטור רקע עם התראות; דוח Endo PDF (`pdfmake`, 10.2 כולל צבעים ועמודת TIR), `/report.pdf`, `/report.json`, לשונית Report | `monitor.js`, `report.js`, `report-pdf.js` | 1–3 |
| **5. אופציונלי** | ביומטריה מאוסף `activity` (HR, Steps); תמיכה ב-`aiCarbs` לטיפולים → Behavior Insights; AGP chart | | 4 |

כל שלב נסגר עם: בדיקות ירוקות, `npm run lint`, README מעודכן, ובדיקה ידנית מול שלושת הפורמטים (OpenAI, Anthropic, Gemini) באמצעות test-connection ו-`/analyze` על נתוני דמו (`bin/testdatarunner.js`).

ענף: `feature/ai-insights` מתוך `dev`, לפי `CONTRIBUTING.md`. סגנון: 2 רווחים, comma-first, גרשיים בודדים, `function name (args)` עם רווח.

---

## 15. סיכונים והכרעות פתוחות

### 15.1 סיכונים

| סיכון | חומרה | מענה |
|---|---|---|
| שחזור TDD מ-Temp Basal אינו מדויק ב-Loop (Loop מעלה temp basal כל 5 דקות, אך לעיתים חסרים) | בינונית | העדפת TDD מדווח כשקיים; ציון `(reconstructed)` בפרומט כדי שהמודל יוריד ביטחון; בדיקות עם fixtures מ-Loop אמיתי |
| ספק אירוח מנתק בקשות ארוכות | גבוהה | תור עבודות + polling (7.4). אין בקשת HTTP שחיה יותר מ-5 שניות מול הדפדפן |
| אזור זמן: ממוצעים שעתיים לפי שעון שרת במקום מטופל | גבוהה (קליני) | `getTimezoneAt` מהפרופיל; בדיקה AI-AGG עם פרופיל ב-`Asia/Jerusalem` ושרת ב-UTC |
| דליפת מפתח ל-`/status.json` | גבוהה | enclave + secureSettings + בדיקה AI-API שמוודאת היעדר |
| הצעות על בסיס מופעי AAPS/Trio שבהם `profile` אינו המקור האמיתי של ההגדרות (AAPS עם autosens/dynamic ISF) | בינונית | שורת `**System**` מתאימה; אם `openaps.suggested.sens` שונה מ-`profile.sens` ביותר מ-10%, מתווספת הערה בפרומט שההגדרות בפועל דינמיות, והביטחון מוגבל ל-`medium` ב-validator |
| עלות לא צפויה בניטור רקע | נמוכה | ניטור כבוי כברירת מחדל; תקציב; מקסימום ריצה אחת ל-6 שעות |

### 15.2 הכרעות שהתקבלו במסמך זה

1. **Apply mode = manual בלבד.** Nightscout אינו כותב הגדרות למכשיר. Loop קורא פרופיל מ-Nightscout רק בכיוון אחד (העלאה). שלב עתידי יכול להשתמש ב-Agent Control Plane RFC ליצירת `delivery-request` מוצע, אבל זה מחוץ להיקף.
2. **מפתח API ב-env בלבד** בשלב 1. UI לעריכת מפתח נדחה עד שתהיה הצפנה במנוחה.
3. **אין SDK של ספקים.** `fetch` מובנה, גופי בקשה ידניים לפי המפרט. זה גם מה שהאפליקציה עושה.
4. **ללא Behavior Insights** עד שיהיה שדה `aiCarbs` בטיפולים.
5. **מטמון Trends מתיישן יומית** ולא רק ברענון ידני, בגלל ריבוי לקוחות.
6. **mg/dL בלבד** (הכרעת בעל המוצר, 2026-10-10). אין המרה בפלט, אין תלות ב-`settings.units`. פרופיל mmol מומר בכניסה בלבד. ראו 2.4 ו-12.2.
7. **`readable` נעול מחוץ ל-AI Insights** (הכרעת בעל המוצר, 2026-10-10). לא רק דרך מבנה ההרשאות אלא גם בבדיקת locked בעלייה ובטעינת הרשאות מחדש. ראו 7.2.
8. **דוח Endo כ-PDF שנוצר בשרת** (הכרעת בעל המוצר, 2026-10-10) עם `pdfmake` כתלות היחידה החדשה. `/report.json` נוסף כתוצר לוואי לתצוגה מקדימה. ראו 9.7.

### 15.3 שאלות שהוכרעו

שלוש השאלות שהועלו בטיוטה הראשונה נענו ב-2026-10-10 ושולבו כהכרעות 6–8 בסעיף 15.2. אין שאלות פתוחות לבעל המוצר כרגע.

---

## נספח א: מטריצת עקיבות מהמפרט

| סעיף במפרט | רכיב בתכן | הערה |
|---|---|---|
| 2 נקודות קריאה 1–6 | `/analyze`, `/trends`, `/chat`, `/meals/advice`, `/meals/pre-meal`, `/meals/:id/debrief` | 7 מחוץ להיקף |
| 3.1 תצורת ספק | 4.2, 8.1 | `temperature` 0.0 ו-`maxTokens` 8192 נאכפים |
| 3.2 פורמטים | 8.1 `detectFormat` | |
| 3.3 גופי בקשה | 8.2 | כלשונם |
| 3.4 חילוץ טקסט | 8.3 `extractText` | 4 שלבים |
| 3.5 בדיקת חיבור | 8.4, `POST /settings/test-connection` | |
| 3.6 עלות ותקציב | 8.5, `ai_usage` | |
| 4 דגלים | 4.3 `ai_settings` | ללא biometrics/mfp/nightscoutImport/applyMode |
| 5.1 UNIT CONTEXT | `prompts/units.js` | תמיד גרסת mg/dL |
| 5.2 אישיות | `prompts/units.js` | 4 טקסטים כלשונם |
| 6.1 חלונות | `analysisPeriod` | |
| 6.2 תזמור | 9.1 | סדר BR→CR→ISF |
| 6.3 אגרגציה | 5.2–5.4, `aggregator.js`, `basal-integrator.js` | |
| 6.4 system prompt | `prompts/settings.js` | snapshot test |
| 6.5 user prompt | `prompts/settings.js` | ראו הבדלים ב-9.1 |
| 6.6.1–6.6.2 | `analyzers.circadian`, `negativeBasal` | שינה מ-`sleepSchedule` |
| 6.6.3 | — | נדחה (HRV) |
| 6.6.4 | `analyzers.foodResponse` | |
| 6.6.5–6.6.6 | `analyzers.caffeine`, `alcohol`, Careportal | |
| 6.6.7 | `analyzers.cgmQuality` | |
| 6.6.8 | `ai_analyses{kind:'debrief'}` | |
| 6.6.9–6.6.10 | — | נדחה (FoodFinder) |
| 6.6.11 | — | נדחה (HealthKit) |
| 6.6.12 | — | מיותר |
| 6.6.13 | — | נדחה (MFP) |
| 6.6.14 | — | נדחה (`originalAICarbs`) |
| 6.6.15 | `context.buildEngagement` | |
| 6.7 אימות | 10, `validator.js` | 11 שלבים |
| 6.8 גבולות | 10 | |
| 6.9 דפוסים | `analyzers.detectPatterns` | |
| 6.10 ציון | `analyzers.settingsScore` | |
| 6.11 ניטור | `monitor.js`, 9.5 | |
| 7.1–7.5 | 9.4, `prompts/meal.js` | debrief מ-`devicestatus.predicted` |
| 8 | — | נדחה |
| 9.1–9.4 | 9.2, `prompts/trends.js`, `context.buildTherapyContext` | |
| 9.5 | 9.3, `prompts/chat.js` | |
| 10 | `report.js`, `report-pdf.js`, `GET /report.pdf` | PDF A4 בשרת, 9.7 |
| 11 מיפוי | 5 | מורחב |

---

## Revision History

| Date | Author | Changes |
|---|---|---|
| 2026-10-10 | — | Initial draft from LoopInsights spec |
| 2026-10-10 | — | Decisions 15.2.6–8: mg/dL only, `readable` locked out with boot-time check, Endo report as server-generated PDF via `pdfmake` (new 9.7) |
