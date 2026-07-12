# Identity Economy Persistence Implementation Plan

1. Add failing tests for the guest save namespace, transition ordering, and lobby counter visibility.
2. Add a canonical guest save namespace to the save vault.
3. Checkpoint guest progress before account hydration.
4. Restore guest progress after account logout.
5. Keep coin and scrap counters visible in lobby cruise mode.
6. Run focused tests, the complete suite, and the production build.
7. Rebuild the Android APK, deploy web and APK to Railway, install on Seeker, and commit the result.
