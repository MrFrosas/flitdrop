# Offline mode (no Wi-Fi, no internet)

The question: "on a train, in a station, out in nature with no network, does it still work like AirDrop?"

## The technical truth (verified, July 2026)

AirDrop works offline because both devices are **Apple**: they form a direct Wi-Fi link (AWDL) between themselves. **Apple locks that technology to its ecosystem.** No third-party app, on any phone, can create that direct link to a Windows PC. And Windows has no equivalent API. So true wireless peer-to-peer between an iPhone and a Windows PC is **impossible for everyone**, not just for us. It is an Apple and Windows limitation, not a Flitdrop one. AirDrop itself only works Apple-to-Apple for exactly this reason.

Bluetooth does not save the day either: iOS forbids third-party apps from sending files to a Windows PC over classic Bluetooth, and Bluetooth Low Energy (the only one allowed) is far too slow for a photo.

## The solution that does work: the computer becomes the network

Windows 11 and macOS can create their **own Wi-Fi hotspot**. The phone joins it like any other Wi-Fi. Both devices are then on a **local network they form themselves**, with no router, no internet. Flitdrop then works normally, at full speed, wherever you are. It is **safer** than a coffee-shop Wi-Fi: the network belongs to your computer, nobody else is on it, and everything stays end-to-end encrypted on top.

### In practice
1. On the computer: turn on the Wi-Fi hotspot (Windows: Settings → Network → Mobile hotspot; Mac: Internet Sharing).
2. On the phone: join that Wi-Fi.
3. Open Flitdrop: the computer is detected, transfers work as usual.

Android can also use **Wi-Fi Direct** with the native app (roadmap), which automates this step entirely.

## Honest summary

| Scenario | Works? |
|---|---|
| Same Wi-Fi (home, office) | ✅ always, full speed |
| No internet, via the computer's hotspot | ✅ yes, network formed by the computer |
| iPhone ↔ Windows pure direct radio like AirDrop | ❌ impossible for any third party (Apple + Windows lock) |
| Android ↔ computer over Wi-Fi Direct | ✅ planned with the native app |

(Version française : [hors-ligne.md](hors-ligne.md).)
