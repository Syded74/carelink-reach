# CareLink Reach Android builds (cht-android flavors)

Copies of the CareLink flavors kept in `cht-android` (`src/<flavor>/`), so the app branding is part of this project.

| Flavor | Server | App name on the phone |
|---|---|---|
| `carelink_reach_azure` | `https://carelink-reach-gh.southafricanorth.cloudapp.azure.com` (demo server) | CareLink Reach |
| `carelink_reach_local` | `http://localhost:5988` on the development Mac, via `adb reverse tcp:5988 tcp:5988` | CareLink (local) |

Both use the CareLink launcher and notification icons. To build, copy a flavor folder into `cht-android/src/`, add its block to `productFlavors` in `cht-android/build.gradle`:

```groovy
carelink_reach_azure {
  dimension = 'brand'
  applicationId = 'org.medicmobile.webapp.mobile.carelink_reach_azure'
}
```

then run (JDK 21) with a release version, or CHT's login page warns "update cht-android" (CHT expects a version starting with `v1.`): `RELEASE_VERSION=v1.8.0 ./gradlew assembleCarelink_reach_azureDebug` and `adb install -r build/outputs/apk/carelink_reach_azure/debug/*-arm64-v8a-debug.apk`.

On Xiaomi/MIUI phones, a first install over USB needs Developer options → *Install via USB*; alternatively copy the APK to the phone's Downloads and install it from the file manager. Updates to an installed app go through `adb install -r` directly. On first launch the app asks "Link domain with CareLink Reach?"; either answer works.
