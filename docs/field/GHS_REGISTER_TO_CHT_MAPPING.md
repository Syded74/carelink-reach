# GHS register to CareLink Reach (CHT) mapping

**Sources:** photographs IMG_0446–0466 from the Kalpohini CHPS visit (22 October 2026), showing blank templates only. Each "visible source field" is a heading legible in the photographs. Headings too small to read are marked **Unreadable source** and are not invented.

**CareLink fields:** the CHT form fields as built by `scripts/build-mch-forms.js` (ANC, PNC and CWC visits; pregnancy; delivery; individual contact).

**Status values:** Exact match, Partial match, Missing, Unreadable source, Not applicable, Requires verification.

**Review:** every clinical field and any new field needs professional review before use. Nothing here adds a diagnosis, classification or threshold.

## 1. Child Welfare Clinic Register (Child Health and Nutrition Register)

These sections are legible in the photographs:
- the three age-group registers (0–11, 12–23 and 24–59 months);
- registration details;
- growth monitoring by month (Month 1–23);
- immunisation (record date given);
- immunisation and Vitamin A supplementation (12–23 and 24–59 months);
- remarks.

| Section | Visible source field | Data type | CareLink field / CHT path | Status | Longitudinal | Aggregate | Notes and review |
|---|---|---|---|---|---|---|---|
| Registration | Sex | M/F | contact `carelink_individual.sex` | Exact match | Yes | Yes | |
| Registration | Mother's name | text | contact `mother_id` (link to the mother's own record) | Partial match | Yes | No | Linked record, not a free-text name |
| Registration | Telephone no. / traceable address | text | contact `phone`; household = address | Partial match | Yes | No | Collect only with consent |
| Registration | Birth weight | kg | — | Missing | Yes | Possible | Candidate field; clinical review |
| Registration | Birth length | cm | — | Missing | Yes | Possible | Candidate field; clinical review |
| Registration | Child's registration no., date of birth, first-visit date | id, date | contact `external_id`, `date_of_birth`; first `carelink_cwc_visit` | Requires verification | Yes | Yes | Some headings partly illegible |
| Age group | 0–11, 12–23, 24–59 months | derived | from `date_of_birth` and the visit date | Partial match | Yes | Yes | Derived only when the birth date is recorded; no derivation implemented yet |
| Growth monitoring (per month) | Date | date | visit `reported_date` / `visit_date` | Exact match | Yes | Yes | One visit record per visit, same child |
| Growth monitoring | W(kg) / Z-S | kg; Z-score | `vitals/weight_kg` | Partial match | Yes | Yes | Weight recorded; **no Z-score computed** (needs approved standards, age and sex) |
| Growth monitoring | L(cm) / Z-S (some months) | cm; Z-score | `vitals/length_height_cm`; `cwc_measurement_position` | Partial match | Yes | Yes | Length/height recorded; no Z-score |
| Growth monitoring | Classify [S] [M] [N] | category | — | Missing | — | — | A nutrition classification: **not implemented without approved standards and clinical review** |
| Growth monitoring | Feeding status (EBF / other) | category | `cwc_feeding_exclusive_breastfeeding`, `cwc_feeding_breastfeeding` | Partial match | Yes | Yes | Exact register codes need verification |
| Growth monitoring | DBS (HIV) sample taken; EID results Pos/Neg | Y/N; result | — | Missing | — | — | Sensitive clinical data; out of scope without authorisation |
| Growth monitoring | NBS for sickle cell disease; result (AA, AS, AC, SC, SS) | Y/N; result | — | Missing | — | — | Sensitive; out of scope without authorisation |
| Immunisation (date given) | BCG, Hep B, Polio 0–3, IPV, Rotavirus, Penta (DTP-HepB-Hib) 1–3, Pneumococcal 1–3, RTS,S, Measles-Rubella, Yellow fever, Others | date per dose | CWC repeat `vaccines/dose` (vaccine, dose, date, verification, source, batch) | Partial match | Yes | Yes | Free-text vaccine names; doses recorded as given. **No schedule or due doses** (by design). RTS,S dose numbering requires verification |
| Vitamin A supplementation (12–23, 24–59) | Vitamin A (dose columns) | date | `cwc_immunisation_records` (free text) or a dose entry | Partial match | Yes | Possible | No dedicated field. Candidate: structured Vitamin A entry (date, capsule type), pending review |
| Remarks | Remarks | text | `care_follow_up_reason` / note fields | Partial match | Yes | No | |

## 2. Maternal (ANC) register

| Section | Visible source field | CareLink field / CHT path | Status | Notes and review |
|---|---|---|---|---|
| Registration | Serial no., Date, Reg. no. | `carelink_pregnancy` record; contact `external_id` | Partial match | |
| Registration | Name, full residential address / phone | contact name, household, `phone` | Partial match | |
| Registration | Age, Parity | `date_of_birth`; `anc_para`, `anc_gravida` | Partial match | Age derived from the birth date |
| Registration | BP (mmHg), HT (m), WT (kg) | `systolic_bp`, `diastolic_bp`, `weight_kg` | Partial match | Height not captured |
| Registration | Gestational age (weeks), EDD | `gestational_age_weeks`, `anc_edd` (+ method, LMP) | Exact match | EDD copied, never calculated |
| Registration | Folic acid & iron supplements | `anc_interventions` (free text) | Partial match | No structured field |
| Registration | Hb at registration (g/dl), G6PD status, blood group (ABO/Rh), sickling status, genotype | `anc_investigations` / shared investigation status (free text) | Partial match | Lab results are sensitive; structured fields need clinical review |
| ITN distribution | ITN date given (Y/N) | — | Missing | Candidate non-diagnostic field (date given) |
| Syphilis screening | Status (+/-), treatment (Y/N) | — | Missing | Sensitive; out of scope without authorisation |
| EMTCT | Known HIV positive; ARV before pregnancy; HIV status at initial test; retest at 34 weeks | — | Missing | Sensitive; out of scope without authorisation |
| TB screening | Screened, diagnosed, treatment started (Y/N) | — | Missing | Out of scope without authorisation |
| Hepatitis B screening | Tested, diagnosed, treatment started (Y/N) | — | Missing | Out of scope without authorisation |
| Subsequent visits (2–12) | Date, GA (wks), Hb (28/36 wks), BP, WT, fundal height, urine protein/sugar, FHR (bpm), folic acid & iron | each ANC visit: `visit_date`, `gestational_age_weeks`, BP, `weight_kg`, `fundal_height_cm`, `fetal_heart_rate_bpm`, `anc_investigations` | Partial match | Hb and urine not structured; one record per visit, linked by `pregnancy_id` |
| TD 1–5, IPT 1–5 | date per dose | `anc_interventions` (free text) | Partial match | Candidate structured entries, pending review |
| Remarks | | `care_follow_up_reason` | Partial match | |

## 3. Stunting monitoring and prevention tally sheet (Sagnarigu Municipal Health Directorate)

| Visible field | Meaning | CareLink support | Status |
|---|---|---|---|
| Age bands 0–11, 12–23, 24–59 months | Rows | Derivable from `date_of_birth` at the measurement date | Partial match (derivation not implemented) |
| Attendance | Children attending | Count of CWC visits per child per period | Partial match |
| Take length every three (3) months (0–23); take height every six (6) months (24–59) | Measurement prompts | Measurements recorded; **no measurement schedule added** | Not applicable (a schedule) |
| Severely stunted (<-3 SD), moderately stunted (≥-3 to <-2 SD), normal, possibly tall / above +3 SD, by sex | Height-for-age classification counts | **Not computed**: needs approved growth standards, validated age/sex inputs and review | Missing (deliberately) |
| Health facility, month, date | Header | Facility contact; period | Exact match |

## 4. Infant and Young Child Feeding (IYCF) practice sheet (Sagnarigu)

| Visible field | CareLink support | Status |
|---|---|---|
| Date of visit | CWC `visit_date` | Exact match |
| Exclusive breastfeeding at 3 months (ask during Penta 3 visit) | `cwc_feeding_exclusive_breastfeeding` at a visit | Partial match (the age window is not derived) |
| Others: other solids or fluids + breastmilk at 3 months | `cwc_feeding_breastfeeding`, `cwc_feeding_complementary_start_date` | Partial match |
| Exclusive breastfeeding at 6 months (ask during Vitamin A visit) | as above | Partial match |
| Others: 6–8 months receiving other solids or fluids + breastmilk | `cwc_feeding_complementary_start_date`, `cwc_feeding_food_groups` | Partial match |
| Vitamin A 100,000 IU (blue capsules); 200,000 IU (red capsules) | No structured field | Missing (candidate: structured entry, pending review) |
| Continuous breastfeeding for 1 year | `cwc_feeding_breastfeeding` | Partial match |
| Total | Aggregate count | Requires a validated aggregate definition |

## 5. Record once, reuse many times

A CWC or ANC visit is one CHT record about one person. It already feeds:
- longitudinal history (profile cards);
- follow-up tasks;
- outreach outcome documentation (resolutions, `lib/oi-links.js`);
- documented workload (`lib/mch-outreach.js`) and CHT targets.

Register-style aggregate counts would come from these records with:
- unique individuals counted separately from encounter totals;
- date-range bounds and age at visit;
- duplicate records removed (one document per `_id`);
- test records excluded.

These aggregate counts are **not implemented**. No DHIMS2 export exists. Official indicator definitions are needed first.

## 6. Proposed minimal extensions (not implemented; awaiting professional review)

1. Structured Vitamin A entry on the CWC visit (date given, capsule type as printed: 100,000 IU blue, 200,000 IU red).
2. ITN date given on the ANC visit.
3. Structured TD and IPT dose dates on ANC visits.
4. Birth weight and birth length on child registration.

All four are documentation of what staff did or measured. None is a classification.
