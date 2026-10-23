# Kalpohini CHPS learning visit: field findings

**Date:** 22 October 2026 (CHPS learning visit, UNICEF AI for Nurturing Care Hackathon).

**Sources:**
- the visit plan (`Learning Visit to Kalpohini CHPS.pdf`);
- nine photographs (`IMG_0446–0466`);
- six staff survey responses and staff explanations, as summarised by the team.

**Evidence status:** the survey figures and quoted staff explanations are the team's summary. We did not audit the facility's inventory, measure shortages or verify service volumes. This is a small local needs assessment and does not generalise to other CHPS facilities.

**Privacy:** the visit plan forbids collecting identifiable client information. The photographs used here show blank register templates, tally sheets and a handwritten weekly plan; no client entries were transcribed. Only column and section headings were read.

## 1. Survey (6 respondents: 3 nurses, 2 CHOs, 1 facility in-charge)

| Topic | Responses |
|---|---|
| Limited health workers | 5 of 6 |
| Transport difficulties | 5 of 6 |
| Insufficient equipment or supplies | 4 of 6 |
| Poor connectivity | 2 of 6 |
| Difficulty communicating with households | 1 of 6 |
| Resource-aware outreach planning "very useful" | 6 of 6 |
| Planning factor: available staff | 5 of 6 |
| Planning factor: transport availability | 5 of 6 |
| Planning factor: fixed outreach schedules | 4 of 6 |
| Planning factor: medical supplies | 4 of 6 |
| Planning factor: fuel availability | 4 of 6 |
| Volunteers participate (regularly or occasionally) | 6 of 6 |
| Paper registers in use | 5 of 6 |
| DHIMS2 or another official reporting system | 4 of 6 |

**Volunteer activities reported:**
- health education;
- locating households;
- announcing outreach dates;
- referral communication;
- missed-visit follow-up.

**Volunteer support requested:**
- local-language information;
- training and supervision;
- confirmed outreach dates.

## 2. Staff explanations (qualitative)

- Carrying equipment and supplies to the community is difficult.
- Motorcycles and other transport are limited.
- Vaccine shortages occur. Planned services cannot always be completed when supplies run out, and families who attend but do not receive the expected service become discouraged.
- Patients are tracked manually through community and facility registers.
- Community volunteers assist the facility.
- CHOs photograph referral documents and share them in a WhatsApp group.

## 3. Documents observed (photographs)

| Photo | Document | Content |
|---|---|---|
| IMG_0446–0448 | GHS Child Health and Nutrition Register: Child Welfare Clinic Register 0–11, 12–23 and 24–59 months | Registration details; growth monitoring per month; immunisation (date given); Vitamin A supplementation (12–23 and 24–59 months) |
| IMG_0456–0458 | GHS maternal (ANC) register | Registration fields; EMTCT; TB and hepatitis B screening; subsequent visits; TD, IPT |
| IMG_0465 | GHS Sagnarigu Municipal Health Directorate stunting monitoring and prevention tally sheet | Aggregate counts by age band and sex |
| IMG_0466 | GHS Sagnarigu Municipal Health Directorate Infant and Young Child Feeding (IYCF) practice sheet | Feeding status at 3 and 6 months; Vitamin A capsules; continued breastfeeding |
| IMG_0464 | Handwritten weekly activity plan for CWC | Static services Monday and Thursday; outreach Tuesday; defaulter tracing and home visits Wednesday |

The two tally sheets name the Sagnarigu Municipal Health Directorate, not Tolon District. They show the form structure only.

## 4. Requirements derived, and where they are addressed

| Field finding | Requirement | Status in CareLink Reach (see `IMPLEMENTATION_VERIFICATION_REPORT.md`) |
|---|---|---|
| Staff shortage, transport and fuel | Plans respect staff, vehicles and fuel | Implemented in Engine 2: staff, hours, vehicles, qualifications and fuel budget |
| Supplies run out; equipment hard to carry | Plans respect configured supplies and equipment; a shortage blocks only the affected services | Implemented in Engine 2, plus Resource readiness records in CHT |
| Families discouraged by unavailable services | Unsupported services are shown before outreach, not discovered on the day | Plans list unmet services and why; unknown stock is never treated as available |
| Fixed outreach schedules | Plans respect the facility's weekly calendar | Calendar implemented (illustrative, unverified; warn or enforce per facility) |
| Manual registers; DHIMS2 reporting | Record once, reuse for registers and aggregates | Mapping in `GHS_REGISTER_TO_CHT_MAPPING.md`; no DHIMS2 integration |
| Referrals shared as WhatsApp photographs | Structured, role-scoped referral records with acknowledgement | Implemented: receiving facility, acknowledgement task, author stamping (`REFERRAL_COORDINATION_WORKFLOW.md`) |
| Volunteers announce dates, need confirmed dates and local language | Confirmed outreach information; reviewed local-language material | Confirmed status on household requests exists. No reviewed audio exists; framework documented only |
| Poor connectivity | Offline capture and later synchronisation | Existing CHT offline-first behaviour, verified on a phone on 22 October 2026 (before this change) |

## 5. Limitations of the evidence

- One facility and six respondents.
- Survey figures are the team's summary.
- No measured inventory or service volumes.
- Tally sheets come from another municipality.
- Small register text is partly illegible in the photographs. Mappings mark those fields as needing source verification.
