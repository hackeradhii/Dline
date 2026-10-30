---
name: Dline
description: Two devices, one direct line. A video call and files between exactly two browsers, drawn as a two-station metro line.
colors:
  paper: "#f1f1ed"
  panel: "#ffffff"
  ink: "#1b1b3a"
  muted: "#595977"
  hairline: "#dcdce4"
  line: "#7b2d8e"
  line-ink: "#ffffff"
  direct: "#00855a"
  relay: "#a86400"
  cut: "#c8322a"
  stage: "#0d0d20"
  band: "#1b1b3a"
  band-ink: "#ffffff"
  band-muted: "#b3b3cc"
  band-line: "#a55bd0"
  band-direct: "#35d495"
  band-relay: "#ffb21f"
  band-cut: "#ff6b5e"
  band-plate: "#7b2d8e"
  band-down: "#c8322a"
  paper-dark: "#0b0b18"
  panel-dark: "#191934"
  ink-dark: "#ececf5"
  muted-dark: "#a6a6c4"
  hairline-dark: "#2c2c50"
  line-dark: "#b878e2"
  line-ink-dark: "#0b0b18"
  direct-dark: "#3dd39a"
  relay-dark: "#f0b24a"
  cut-dark: "#ff7a70"
  stage-dark: "#06060f"
  band-dark: "#1e1e4a"
typography:
  display:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.06em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 800
    letterSpacing: "-0.01em"
  item:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 800
  body:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.375
  data:
    fontFamily: "Overpass Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  plate: "8px"
  panel: "14px"
  sheet: "16px"
  pill: "9999px"
spacing:
  gutter: "16px"
  gutter-sm: "24px"
  panel-pad: "20px"
  panel-pad-sm: "24px"
  stack: "24px"
  columns: "32px"
  stop-indent: "36px"
  band-bar: "56px"
components:
  button-primary:
    backgroundColor: "{colors.line}"
    textColor: "{colors.line-ink}"
    rounded: "{rounded.plate}"
    typography: "{typography.label}"
    padding: "2px 20px 0"
    height: "48px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "2px 20px 0"
    height: "48px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.plate}"
    padding: "2px 12px 0"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.cut}"
    textColor: "#ffffff"
    rounded: "{rounded.plate}"
    padding: "2px 20px 0"
    height: "48px"
  button-band:
    backgroundColor: "transparent"
    textColor: "{colors.band-muted}"
    rounded: "{rounded.plate}"
    padding: "2px 12px 0"
    height: "40px"
  button-stage:
    backgroundColor: "#ffffff"
    textColor: "{colors.stage}"
    rounded: "{rounded.plate}"
    padding: "2px 20px 0"
    height: "48px"
  call-control:
    backgroundColor: "rgb(255 255 255 / 0.16)"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "56px"
  plate-direct:
    backgroundColor: "{colors.band-plate}"
    textColor: "#ffffff"
    rounded: "{rounded.plate}"
    padding: "7px 12px 6px"
  plate-relay:
    backgroundColor: "{colors.band-relay}"
    textColor: "{colors.band}"
    rounded: "{rounded.plate}"
    padding: "7px 12px 6px"
  plate-cut:
    backgroundColor: "{colors.band-down}"
    textColor: "#ffffff"
    rounded: "{rounded.plate}"
    padding: "7px 12px 6px"
  plate-flat:
    backgroundColor: "transparent"
    textColor: "{colors.band-ink}"
    rounded: "{rounded.plate}"
    padding: "7px 12px 6px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  call-stage:
    backgroundColor: "{colors.stage}"
    textColor: "#ffffff"
    rounded: "{rounded.panel}"
    padding: "32px"
  sheet:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "0 24px 24px"
  input-code:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "2px 16px 0"
    height: "48px"
  progress:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.line}"
    rounded: "{rounded.pill}"
    height: "6px"
---

# Design System: Dline

## Overview

**Creative North Star: "The Two-Station Metro Line"**

The connection is a metro line with exactly two stations. You and Them are the termini, the purple line between them is the path, the ticks under it are the real file lanes, and a train runs along it while files move. Every screen starts with a navy signage band carrying that line and a line-name plate that says how you are connected ("Direct on the same network (IPv4), <1 ms ping, 4 lanes"). Below the band is the platform: a pale tile ground with soft white panels, the dark call stage, and the files column drawn as stops on a vertical purple line.

The world is transit signage, not app chrome. Type is Overpass (a highway-signage face) set heavy, labels are plain sentences, and status colours are lamps that mean exactly one thing each. Density is calm: one panel or one stage plus one column, generous 48px controls, phones and laptops treated equally. Motion is mechanical and purposeful: dashes run while a line is being built, a train runs while files move, a ring pulses while a call is ringing, and everything else is still.

The category default this world refuses is a status pill floating over a generic video tile. Connection truth lives in the band, always, and a relayed line can never look like a direct one.

**Key Characteristics:**
- Navy signage band on every screen holds the wordmark, the metro line and the line-name plate.
- Purple is the line: the primary action, the files line, the focus ring, the caret.
- Green, amber and red are lamps (direct, relayed, lost) and nothing else.
- Overpass Variable, heavy (800) for anything you read first; tabular figures for every number.
- 8px plates for controls, 14px soft-shadowed panels without borders, full circles for stations and call controls.
- Light and dark follow the system; the band stays navy in both.

## Colors

A signage palette: navy and tile neutrals carry the space, one purple carries the line, and three lamp colours carry connection state.

### Primary
- **Namma Line Purple** (`line`): the line itself on the ground. Primary buttons, the vertical files line and its stop markers, progress fill, focus outline, caret, selection tint. Lifts to **Lit Line Purple** (`line-dark`) in dark mode so it stays legible on near-black, with `line-ink` flipping from white to near-black.
- **Band Line Purple** (`band-line`): the same line drawn on the navy band (track, stations' rings, wordmark glyph). **Plate Purple** (`band-plate`) fills the line-name plate while the line runs direct.

### Secondary (status lamps)
- **Direct Green** (`direct` / `band-direct`): a direct peer-to-peer path. The lamp on the plate, the ok notice tint, completed-and-verified tone.
- **Interchange Amber** (`relay` / `band-relay`): relayed, not peer to peer. Fills the plate and rings the "Relay" interchange on the line; also the warn notice and the runnable-file warning text.
- **Break Red** (`cut` / `band-cut` / `band-down`): lost, failed, cancelled, end call, decline. The broken line, the down plate, error text, the danger button.

### Neutral
- **Signage Navy** (`band`): the band ground; same value as `ink`, so the band reads as the darkest ink spread wide. Deepens slightly toward blue (`band-dark`) in dark mode so it separates from the near-black ground.
- **Platform Tile** (`paper`): the page ground and the code input's fill. **Night Platform** (`paper-dark`) in dark mode.
- **Panel White** (`panel`): panels, notices, sheets, empty stop markers. Indigo-tinted (`panel-dark`) in dark mode.
- **Ink Navy** (`ink`) and **Slate Muted** (`muted`): primary and secondary text on the ground.
- **Hairline** (`hairline`): dividers, the progress track, the dashed empty-files line, the input border at rest, scrollbars.
- **Tunnel Black** (`stage`): the call stage, before and during a call.
- **Band Ink / Band Muted** (`band-ink`, `band-muted`): text on the navy band; muted also draws the planned (unbuilt) line.

### Named Rules
**The One Meaning Rule.** Green means direct, amber means relayed, red means lost or destructive. Never use a lamp colour for decoration, branding or emphasis.

**The Band Token Rule.** Anything on the navy band uses `band-*` tokens; anything on the ground or panels uses the ground tokens. The band values are tuned for navy and are not swapped in dark mode.

**The Line Is Purple Rule.** Purple marks the path and the action that moves along it. It is never a status colour: a direct plate is purple with a green lamp, not green.

## Typography

**Display Font:** Overpass Variable (with ui-sans-serif, system-ui, Segoe UI, Roboto)
**Body Font:** Overpass Variable
**Label/Mono Font:** Overpass Variable with tabular figures (`font-variant-numeric: tabular-nums`)

**Character:** One signage face at two weights of voice: extra-bold (800) for anything you read first, regular for explanation. Headlines track slightly tight; room codes track wide like a platform number. Buttons sit on a 2px top padding to optically centre Overpass's high baseline.

### Hierarchy
- **Display** (800, 2.75rem to 3.25rem, line-height 1, +0.06em, tabular): the room code on the hosting panel only.
- **Headline** (800, 2.125rem to 2.5rem, 1.08, -0.025em, balanced): the home band's one-sentence promise.
- **Title** (800, 1.75rem to 2rem, leading-tight, -0.02em): screen titles (waiting, ended) and "You're connected" on the stage.
- **Section** (800, 1.375rem, -0.01em): "Files", sheet titles.
- **Item** (800, 1.0625rem): a file stop's name; band wordmark at 1.3rem, -0.02em.
- **Body** (400, 0.95rem to 1.05rem, line-height 1.625): explanations, notices; capped near 34rem.
- **Label** (700 to 800, 0.875rem): plate details, captions, "You"/"Them" station names (800), quiet links.
- **Data** (tabular, 0.875rem): speeds, sizes, durations, ping, lanes, codes.

### Named Rules
**The Tabular Truth Rule.** Every live number (ping, speed, bytes, time, lane count, code) is set in tabular figures so it never jitters while it updates.

**The Sentence Label Rule.** Labels are sentence case, plain words. No uppercase kickers or eyebrows above headings; the only uppercase is the typed room code.

## Layout

Two widths. Pairing and status screens use a single 36rem column (`max-w-xl`); the room widens to 72rem (`max-w-6xl`). The band and the content share the same container, so the line's termini align with the content edges. Side gutters are 16px, 24px from 640px.

The band is a 56px bar (wordmark left, one band action right) followed by its content (the line, the plate, and on home the headline) with 20px below. The ground stacks with 24px gaps.

The room is the call stage plus the files column. Below 1024px they stack (stage first). From 1024px they sit side by side: stage `minmax(0, 1fr)`, files 23rem, 32px apart. The pre-call stage is 16:9 at desktop and at least 17rem tall on phones; the live stage is `min(68dvh, 42rem)`, at least 22rem.

Files hang from a vertical line 9px in from the column edge; each stop is indented 36px and separated by 24px.

## Elevation & Depth

Mostly flat, with one soft lift. Panels and notices float off the tile ground on a single two-layer ambient shadow; nothing on the band or the stage casts a shadow. Depth between the band, the ground and the stage comes from tone (navy, tile, near-black), not from shadows or borders.

### Shadow Vocabulary
- **Lift** (`0 1px 2px rgb(27 27 58 / 0.06), 0 10px 28px -6px rgb(27 27 58 / 0.1)`; dark: `0 1px 2px rgb(0 0 0 / 0.4), 0 12px 32px -8px rgb(0 0 0 / 0.5)`): the one panel elevation (home connect panel, hosting code panel, ended panel, notices).
- **Sheet**: the modal sheet on a native dialog, over a `rgb(11 11 31 / 0.55)` backdrop.
- **Self-view** (`0 8px 24px rgb(0 0 0 / 0.45)` with a 2px white ring): your own camera preview on the stage.

### Named Rules
**The No-Border Panel Rule.** Panels are separated by the lift and the tile ground, never by a stroke. Rings are reserved for focus, drag-over, the received-file card and the flat plate.

## Shapes

Three corners and a circle. Controls and plates are 8px; panels, notices and the call stage are 14px; sheets are 16px (squared at the bottom on phones, where they rise from the edge). Stations, file stops, call controls, the train, the interchange and progress bars are fully round. The line itself is a thick round-capped rule (8px; 6px compact) with 3px by 7px ticks hanging below it, one per lane. The break in a lost line is a 24-degree skewed cut in band navy.

## Components

### Buttons
Heavy, square-shouldered plates that answer the press.
- **Shape:** gently rounded plate (8px); 48px tall for main actions, 44px quiet, 40px on the band; 800 weight (700 for quiet and band).
- **Primary:** line purple fill, white text (near-black in dark). One per view: "Start a line", "Accept".
- **Secondary:** 2px ink outline at 85%, no fill; 5% ink wash on hover. "Join", "Send files", "Save".
- **Quiet:** muted text that turns ink and underlines on hover.
- **Danger:** break red fill, white text. Decline, end.
- **Band:** muted band ink, 10% white wash on hover. "Leave", settings.
- **Stage:** white fill, tunnel-black text, for the one action on the dark stage ("Start video call").
- **Press / Focus:** every pressable scales to 0.97 on press (160ms, `ease-out`); focus is a 3px line-purple outline 2px out (white on the band). Disabled drops to 45% opacity.

### Line-Name Plate (signature)
The plate under the line names the line, like a metro line's sign. A 10px lamp, then a bold title and tabular details at 80%. Direct: plate purple with a green lamp. Relayed: amber plate, navy text and lamp. Lost: red plate, white lamp. Idle: 10% white. The **flat** variant keeps only the lamp colour inside a 1px 20% white inset ring; it is used where status sits near a primary button (the home network check), so status never reads as a button.

### The Metro Line (signature)
Two 24px stations (18px compact) joined by the track, "You" and "Them" in 800 labels below. Idle: dashed muted track at 45%, Them drawn as an empty ring (not built). Connecting: dashes run (0.8s linear). Direct: solid band-purple track with one tick per lane (max 16). Relayed: an amber-ringed "Relay" interchange sits mid-line. Lost: the line turns band red and is cut. While files move, a white train with a coloured ring runs end to end (1.6s, `ease-drawer`). In the room the whole band block opens the connection details sheet.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** panel white on tile; the call stage is tunnel black.
- **Shadow Strategy:** the Lift (see Elevation); the stage has none.
- **Border:** none.
- **Internal Padding:** 20px, 24px from 640px; stage 24px to 32px.

### Notices
Panel-shaped (14px, lifted) with a 19px icon. Info is plain panel with a muted icon; warn, error and ok tint the panel 11 to 12% toward amber, red or green and colour the icon. Error is an alert; the rest are status.

### Inputs / Fields
- **Style:** 48px, 8px corners, 2px hairline border, tile fill (it sits inside a white panel), bold tabular uppercase with 0.08em tracking for the code; placeholder normal case, regular weight, muted.
- **Focus:** border turns line purple.
- **Error:** border turns break red; the message below is semibold red.

### File Stops
Files run newest first as stops on a 4px vertical purple line. Marker (22px circle): in progress is a white stop with a 5px purple ring and a direction glyph; done is a filled purple stop with a check; failed or cancelled is a red ring. Name in Item type, detail in tabular muted text (semibold red on failure), a 6px purple progress bar while moving. Empty state: a dashed hairline line and "Nothing sent yet". Dragging files over the column washes it 8% purple with a 2px purple ring.

### Call Controls
56px frosted circles (16% white, backdrop blur) on a bottom gradient over the video; a pressed toggle (muted mic, camera off) turns solid white; end call is a 72px-wide red capsule.

### Sheet
Native dialog, panel fill, 16px corners, sticky title row with a close button. Desktop: centred, up to 34rem, rises 12px and scales from 0.98. Phone: full width from the bottom edge, slides up (260ms, `ease-drawer`).

## Do's and Don'ts

### Do:
- **Do** put the navy band with the metro line and line-name plate at the top of every screen, and keep the connection type visible in it at all times.
- **Do** draw new connection or transfer states as states of the line (track style, ticks, interchange, break, train) before reaching for a badge.
- **Do** use `band-*` tokens on the band and ground tokens below it.
- **Do** set every changing number in tabular figures.
- **Do** give anything pressable the press response (scale 0.97, 160ms) and the 3px purple focus outline.
- **Do** use the flat plate when status sits next to a primary button.
- **Do** keep one primary (purple) button per view; the stage gets the white stage button instead.

### Don't:
- **Don't** use green, amber or red for anything but direct, relayed and lost or destructive states.
- **Don't** let a relayed connection share the direct plate's purple; relayed is always amber with the "Relay" interchange on the line.
- **Don't** put borders on panels or add a second panel shadow; use the Lift.
- **Don't** float a status pill over the video; status belongs to the band.
- **Don't** add uppercase eyebrows or kickers above headings.
- **Don't** animate anything that is not a real process (building the line, files moving, a call ringing); reduced motion stops all of it.
