# CHT Core patches

> **Status (2026-10-21): NOT APPLIED.** The team chose the standard CHT interface and to focus on functionality. The patch below was reversed (`patch -R -p1`), the webapp rebuilt, and CHT Core is again unmodified. It is kept here only for reference.

CareLink keeps changes to CHT Core to this folder. **0001 is not applied; 0002 is applied** (approved by the project owner on 22 October 2026 as an exception to the "no CHT Core changes" rule).

## 0001-carelink-brand-colours.patch

**Why it is needed:** in CHT 5.3 the toolbar colour of the built-in tabs (Messages, Tasks, Reports, People, Targets) and the navigation rail are hard-coded in LESS (`webapp/src/css/variables.less`, `inbox.less`). No app setting or branding key changes them. Only UI-extension tabs accept `accent_color`.

**What it changes (stylesheets only, no logic):**

| Element | Before | After |
|---|---|---|
| Side navigation rail / mobile tab bar | near-black | primary green `#0E7A53` (white icons/text, existing) |
| Selected tab | dark grey | `#0A5C3E` |
| Tab toolbars | blue / periwinkle / pink / yellow / teal | soft mint `#D1FAE5` (existing dark title text, ≈12:1 contrast) |
| List accent borders | per-tab colours | `#0E7A53` |
| Page background | light grey | `#F1FDF5` |

**Apply, build and publish:**

```sh
cd ~/Downloads/cht-core-master
patch -p1 < ~/Downloads/carelink-reach-config/core-patches/0001-carelink-brand-colours.patch
(cd webapp && npm run build -- --configuration=development)   # writes api/build/static/webapp
cd ~/Downloads/carelink-reach-config && npm run deploy          # re-uploading branding makes CHT regenerate
                                                                # its service worker, so browsers fetch the new CSS
```

**Revert:** `patch -R -p1 < …/0001-carelink-brand-colours.patch`, rebuild, and deploy again.

**Maintenance:** check that the patch still applies before every CHT upgrade (`patch -p1 --dry-run`). For a production Docker deployment it means building and hosting a custom CHT image. That image is a modified AGPL-3.0 work, so its source must be offered to its network users. The alternative is to drop the patch and accept CHT's default colours.


## 0002-carelink-sidebar-menu.patch — **APPLIED (2026-10-22)**

**Why it is needed:** the side menu entries **Storage info**, **Training materials**, **About** and **Report bug** are hard-coded in CHT 5.3 with no permission or app setting to hide them:
- `SIDEBAR_TABS` in `header-tabs.service.ts` has `permissions: []`;
- Storage info is in both menu templates for every offline user.

UI extensions cannot hide them either, because their code loads only when their own tab opens.

**What it changes (three files, no data or logic changes):**

| File | Change |
|---|---|
| `webapp/src/ts/services/header-tabs.service.ts` | Removes the `trainings`, `about` and `bug` entries from `SIDEBAR_TABS` |
| `webapp/src/ts/components/sidebar-menu/sidebar-menu.component.html` | Removes the Storage info block |
| `webapp/src/ts/components/header/header.component.html` | Removes the Storage info entry from the legacy header menu |

**Kept:**
- Sync now, sync status, edit user settings (with permission), privacy policy (when configured), App Management (admins, online) and Log out;
- the `/trainings` and `/about` routes, which still exist but are no longer linked from the menu.

**Apply, build and publish:**

```sh
cd ~/Downloads/cht-core-master
patch -p1 < ~/Downloads/carelink-reach-config/core-patches/0002-carelink-sidebar-menu.patch
(cd webapp && npm run build -- --configuration=development)
# restart the CHT API so it regenerates the service worker; phones and browsers then fetch the new menu
```

**Reverse:** `patch -R -p1 < …/0002-carelink-sidebar-menu.patch`, rebuild, restart the API.

**Verified:**
- **Chrome:** all four roles (volunteer, CHO, coordinator, supervisor) list only App Management, Sync now, sync status and Log out in the menu markup.
- **Physical phone (CHO):** the menu shows only Sync now and the sync status (`evidence/outreach-first/phone-menu-cho.png`).
- **CHT's own webapp unit tests:** not run for this change. `header-tabs.service.spec.ts` may expect the removed entries.

**Maintenance:** this must be re-applied after any CHT Core upgrade.
