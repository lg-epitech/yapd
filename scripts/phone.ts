// `bun run phone`: builds the iPhone app in ios/, signed with your Apple ID's
// team in Xcode, and installs it on the iPhone connected to this Mac, which
// it registers with that team the first time. A free
// Apple ID works, though its apps stop opening after a week: run this again.
// YAPD_TEAM picks the team when Xcode has several, YAPD_PHONE the phone, by
// name or id, and YAPD_BUNDLE_ID the app's id when dev.yapd.phone is taken.

import { $ } from "bun"
import { homedir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const built = join(root, "ios", "build")

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

/**
 * The teams of the Apple IDs Xcode is signed in to: as older Xcodes list
 * them, or from the Apple Development certificates Xcode made for them, whose
 * organizational unit is the team.
 */
const teams = async () => {
  const prefs = join(homedir(), "Library", "Preferences", "com.apple.dt.Xcode.plist")
  const read = await $`plutil -extract IDEProvisioningTeamByIdentifier json -o - ${prefs}`.quiet().nothrow()
  if (read.exitCode === 0) {
    const accounts = JSON.parse(read.stdout.toString()) as Record<string, ReadonlyArray<{ teamID?: string; teamName?: string }>>
    const listed = Object.values(accounts)
      .flat()
      .flatMap(({ teamID, teamName }) => (teamID === undefined ? [] : [{ id: teamID, name: teamName ?? teamID }]))
    if (listed.length > 0) return listed
  }
  const pems = (await $`security find-certificate -a -c ${"Apple Development"} -p`.quiet().nothrow()).stdout.toString()
  const found = new Map<string, string>()
  for (const pem of pems.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((part) => part.includes("BEGIN"))) {
    const subject = (await $`openssl x509 -noout -subject -nameopt multiline < ${new Response(pem)}`.quiet().nothrow()).stdout.toString()
    const id = /organizationalUnitName\s*=\s*([A-Z0-9]{10})/.exec(subject)?.[1]
    const name = /organizationName\s*=\s*(.+)/.exec(subject)?.[1]?.trim()
    if (id !== undefined) found.set(id, name ?? id)
  }
  return [...found].map(([id, name]) => ({ id, name }))
}

const team =
  process.env.YAPD_TEAM ??
  (await teams().then((found) => {
    if (found.length === 0) {
      fail("Sign in to Xcode with your Apple ID first: Xcode, Settings, Accounts, a free one works. Then Manage Certificates, +, Apple Development.")
    }
    if (found.length > 1) console.error(`Signing with ${found[0]!.name}. YAPD_TEAM picks another of: ${found.map(({ id, name }) => `${name} (${id})`).join(", ")}`)
    return found[0]!.id
  }))

/** The iPhones this Mac can install on now: connected, paired and in Developer Mode. */
const phones = async () => {
  const out = join(built, "devices.json")
  await $`mkdir -p ${built}`.quiet()
  await $`xcrun devicectl list devices --json-output ${out}`.quiet().nothrow()
  const listed = (await Bun.file(out).json().catch(() => ({}))) as {
    result?: {
      devices?: ReadonlyArray<{
        identifier: string
        deviceProperties?: { name?: string }
        hardwareProperties?: { platform?: string; udid?: string; reality?: string }
        connectionProperties?: { pairingState?: string; tunnelState?: string }
      }>
    }
  }
  return (listed.result?.devices ?? [])
    // A real one: devicectl lists simulators too.
    .filter((device) => device.hardwareProperties?.platform === "iOS" && device.hardwareProperties.reality !== "simulated" && device.connectionProperties?.pairingState === "paired")
    .map((device) => ({
      id: device.identifier,
      udid: device.hardwareProperties?.udid ?? device.identifier,
      name: device.deviceProperties?.name ?? device.identifier,
      connected: device.connectionProperties?.tunnelState !== "unavailable",
    }))
}

const wanted = process.env.YAPD_PHONE
const found = (await phones()).filter((phone) => wanted === undefined || phone.name === wanted || phone.id === wanted)
const phone = found.find(({ connected }) => connected) ?? found[0]
if (phone === undefined) {
  fail(
    "No iPhone to install on. Connect it with a cable, unlock it and trust this Mac, then turn on Developer Mode in Settings, Privacy & Security, and run this again.",
  )
}

console.log(`Building yapd for ${phone!.name}`)
const build = await $`xcodebuild -project ${join(root, "ios", "yapd.xcodeproj")} -scheme yapd -configuration Release -destination id=${phone!.udid} -derivedDataPath ${built} -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet DEVELOPMENT_TEAM=${team} ${process.env.YAPD_BUNDLE_ID === undefined ? [] : [`YAPD_BUNDLE_ID=${process.env.YAPD_BUNDLE_ID}`]} build`.nothrow()
if (build.exitCode !== 0) fail("The build failed. If it says the app's id is taken, set YAPD_BUNDLE_ID to one of your own, like com.yourname.yapd.")

const app = join(built, "Build", "Products", "Release-iphoneos", "yapd.app")
const installed = await $`xcrun devicectl device install app --device ${phone!.id} ${app}`.nothrow()
if (installed.exitCode !== 0) fail(`Installing on ${phone!.name} failed. Unlock it and try again.`)
console.log(
  `yapd is on ${phone!.name}. The first time, trust it in Settings, General, VPN & Device Management. Then run yapd pair on your server, and set the Action button to Controls, Talk to yapd.`,
)
