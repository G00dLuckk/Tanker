# Tanker Time

A 3D tank level simulator for setting up and calibrating level sensors.

Describe any tank (shape of the top, body and bottom, sizes, wall thickness, tilt) or any open concrete storage (the plan drawn corner by corner, the wall height, how the floor slopes, sumps), place your sensors on the roof, the wall top or the floor, move the liquid level, and see what each sensor reads. A site can hold as many tanks as you like, side by side in the 3D view. **Scripts & table** gives you the two scripts of the device model on the platform, **Configuration** and **Payload**, for every tank and sensor of the site, and the level → volume **Table** of the tank you are editing.

## Open it

- **No install:** double-click `dist/index.html`. It is one self-contained file (about 1.2 MB) and works offline in Chrome, Edge or Firefox. You can copy that single file anywhere or put it on any web server.
- **Development:** needs Node.js 20 or newer.

```bash
npm install
npm run dev      # live development server at http://localhost:5173
npm test         # volume, sensor, table and script tests, and the acceptance tests of the generated scripts
npm run build    # type-check, then write dist/index.html
```

The generated scripts can also be checked by hand with the Cloud Studio harnesses in `tools/`, which mock the platform API and feed the sensor manuals' own frames:

```bash
node tools/cloudstudio-test-harness.js payload.js config.js 244E7B0000004656       # LoRaWAN model, a DevEUI of DEVICE_TANKS
node tools/cloudstudio-test-harness-tcp.js payload.js config.js 866207058378443    # TCP model, an IMEI of DEVICE_TANKS
```

Every `ok:` line must appear and the exit code must be 0. `tests/acceptance.test.ts` runs both, plus `node --check`, an ES5 token scan, the volume spot checks, monotonic curves, invalid readings and the device round trip, on the scripts generated for the Asphalt Storage 7 + 8 example.

## How to use it

1. **Tank shape.** Start from the **Tank library** (23 designs in four groups: vertical, horizontal, box and special shapes, concrete storages — for example water tank, silo with 60° hopper, stepped tank, capsule, underground fuel tank, road tanker, box-oval road tanker, trapezoidal fuel tank, octagonal and hexagonal tanks, an asphalt storage with a sloped floor and a basin with a sump) or build your own. The first choice is **what holds the liquid**: a **tank** (a shell with two ends, below) or a **concrete storage** (an open pit, see step 1b). Body and end shapes are picked from picture tiles, grouped into families:
   - orientation: vertical or horizontal,
   - body (cross-section):
     - **Round:** cylinder, oval (elliptical), sphere.
     - **Flat sides:** box (optional rounded corners), box with cut (chamfered) corners, polygon (6, 8, 10 or 12 flat sides), trapezoid (two widths).
     - **Round and flat:** stadium, box-oval (superellipse, with a squareness setting), D-shape (flat floor, round roof), U-shape (round bottom, flat top).
   - top head and bottom (footer) for vertical tanks, left and right ends for horizontal tanks:
     - **Flat:** flat; flat with a knuckle (flanged-only head).
     - **Domed:** shallow dome (by depth or by dish radius), torispherical (Klöpper DIN 28011, Korbbogen DIN 28013, ASME F&D, 80:10 or custom radii), semi-ellipsoidal (by ratio such as 2:1, or by head depth), hemispherical, paraboloidal.
     - **Conical:** cone / pyramid hopper with outlet (centred or eccentric); cone with a knuckle (toriconical, round tanks).
     - **Sloped floor or roof** (standing tanks with flat sides): V-trough, single slope.
   - the shell along its length: straight, tapered, or **stepped / custom** (type the size at several heights, for tanks with two diameters or a cone in the middle).
   - shallow domes and semi-ellipsoidal heads can also be sized by **arc length** (a tape laid over the head; with outside sizes, from the outside wall on one side to the outside wall on the other), and torispherical heads by **Measured sizes**: the **head depth only**, the **arc length only** (the knuckle follows the standard, 0.1 × D for DIN / Klöpper, and the crown radius is worked out), or any two of head depth, crown (arc) radius, knuckle radius and arc length,
   - **Sizes as X, Y, Z**, as in the 3D view: a standing tank has X width, Y depth, Z height; a lying tank has X length, Y width, Z height. Each end shows its size too (the two sizes across come from the shell, the third is the head depth).
   - **Same size (X = Y = Z)** for the body: width, depth and straight shell length are one size; type any of them and the others follow. Each half-oval, paraboloid, cone, V-trough or slope end has its own **Same size** switch that makes the head as deep as the shell is wide at that end, and follows the shell when its size changes. (Domes, hemispherical and torispherical heads cannot be that deep.)
   - **Same shape at both ends** sizes both ends with one set of fields (both get the same inside shape; plate thicknesses stay separate). Turn it off to set each end on its own.
   1b. **Concrete storage (open pit).** For an asphalt storage, a basin or a bund: choose **Concrete storage** and design it in plan, the way the engineer's drawing shows it:
   - **Plan outline:** the corners of the inside of the walls, X and Y in mm, in order around the outline. Any simple polygon works (rectangle, trapezoid, L-shape, cut corners); the rectangle tool fills in a width × length. The top view under the sensors draws it.
   - **Floor:** **flat**; **one slope** (a direction in the plan and the total drop from the low wall to the high wall); or **heights at the corners** (the floor height at every corner, interpolated across the plan, for several slopes, a ridge or a step — put extra corners on a straight side where the slope changes). **Sumps** are rectangular pits in the floor with their own depth. A **wall batter** (mm per m) makes the inner faces lean outward; 0 is vertical.
   - **Level zero is the deepest point of the floor** (the bottom of the deepest sump), so a level is never negative and the scripts treat a storage like any tank. Drawings often measure from somewhere else (the shallow end, the outlet): choose **Heights on the drawing are measured from** and type the wall height, the operation level, the alarms and the check values as they are written; the app shows each one above level zero.
   - **Check values:** capacities printed on the drawing at given levels. The design is compared with them and a difference of more than 0.5 % is flagged in the panel and in the script warnings.
   - Wall widths and the slab thickness are drawn in 3D only; the volume is worked out numerically over the plan (a grid of at least 500 cells across, refined until the capacity settles; flat floors are exact, a sloped floor matches the wedge + prism formula to a few parts in 10⁵).
   - A top sensor sits **on the wall top** with a **bracket height** (its face above the wall), or with its face height typed. The sensor card shows the distance to the floor under it (what it reads when the storage is empty): keep it inside the sensor's range (4 m for a TEK 766, 3 m with a waveguide) by placing the sensor over the shallow part of the floor, and give the bracket at least the dead band (220 mm for a TEK 766) so a full storage can be measured. The app warns about both.

2. **Dimensions and wall thickness.** Choose whether you measured the **outside** or the **inside**. With outside measurements, inside size = outside − 2 × wall. Shell, top and bottom can have different thicknesses. Give the shell size as the **diameter / width** or as the **circumference** (a tape around the shell), and the length as the **straight shell** (tangent to tangent) or the **overall length end to end**; a circumference or overall length you type stays fixed when you change the ends, and the rest is worked out. **Fit the size to a capacity** solves the shell height (or the diameter) for a capacity you type.
3. **Installation & liquid.** Tilt (a vertical tank leaning, or a horizontal tank sloping along its length), liquid density, and optional overflow and outlet levels.
4. **Manholes (hole doors).** Add a **Manhole** in the Sensors section for each opening on the roof (or on top of a horizontal shell): round or rectangular, its clear opening, its position, and the height of its cover as the **neck height** (outside roof at the manhole centre to the top of the cover) or as the **cover top above level zero**. It works on every roof shape; on a dome, cone or a horizontal shell the neck is drawn down to the lowest roof point under the opening. Drag it in the top view; sensors on its cover move with it. A **concrete storage** with a slab on top can have manholes too: there the height of the cover counts from the wall top (slab thickness + frame). A manhole always has its own size, never the tank's or the storage's.
5. **Sensors.** Add a **Top** sensor (ultrasonic, radar, laser), a **Bottom** sensor (hydrostatic pressure, submersible probe) or a level **Switch**. Drag sensors in the top view or type X/Y. A top sensor sits **on the roof** (face = roof + plate + nozzle), **on a manhole** (face = top of the cover + the sensor height above it; negative when the face is below the cover top), or you type the face height. For each sensor set the dead band, range and beam angle, and the output your script reads: a digital value, 4–20 mA or a voltage, optionally through an ADC with shunt resistor or divider.
6. **Simulate.** Drag the sight glass on the right of the 3D view (or use the arrow keys on it), or press **Fill** / **Drain** with a flow rate. Turn on **Noise** to see each sensor's scatter. The sight glass has a uniform level scale on the left and a dipstick-style % volume scale on the right.
7. **Field calibration (per sensor).** Open a sensor card and choose the calibration type:
   - **From the drawing**: only the tank size and sensor settings.
   - **1-point (offset)**: one true level and the raw value at that moment; fixes a constant error (for example the sensor sits 12 mm higher than drawn).
   - **2-point (zero and span)**: one low and one high point; fixes offset and slope (wrong density, transmitter range a little off).
   - **Multi-point (best fit)**: three or more points, for example while filling with a flow meter; a best-fit line, with the error of each point shown.
   The true value can be a **level** (dipstick, tape) or a **volume** (flow meter, known fills). The fitted correction is `true level = α + β × drawing level`, so the sensor formula stays `level = A + B × raw`, and every export uses the calibrated A and B.
8. **Tanks of the site.** The bar above the 3D view lists the tanks of the site. **+** adds a blank tank, the copy button adds a copy of the tank you are editing, and the cube shows every tank. Click a tank's name in the bar or its tag in the 3D view to edit it; the panels always edit that tank, and **×** removes it (with Undo). The tanks stand side by side, each with its own simulated level.
9. **Scripts & table** (header button, or **Configuration** / **Payload** / **Table** in the right-hand panel). Three tabs, each with **Copy** and **Download**:
   - **Sensor family**: there is one device model per kind of sensor, never both in one. **LoRaWAN (DevEUI)**: TEK 766, Dragino, Milesight, Netvox, or an object decoded by the network server. **TCP / SIM card (IMEI)**: TEK 811 / 811 LR / 822 and the newer Tekelek cellular frame (binary or hex text), and JSON text. The choice follows the devices you paste (all IMEIs → TCP) until you set it; a site with both kinds needs both models (switch, copy both scripts again). Devices of the other kind are listed in the warnings, not in the scripts.
   - **Configuration**: `MM_VARIABLE_ID`, `PERCENT_VARIABLE_ID`, `LITRES_VARIABLE_ID`, then `DEVICE_TANKS` (address → sensor number). It creates the endpoints of each device and checks the address when a device is created: a DevEUI (16 hexadecimal characters) in the LoRaWAN model, an IMEI (15 digits) in the TCP model, listed in `DEVICE_TANKS`.
   - **Payload**: `TANKS` (one numbered entry per sensor), then `SHOW_ALL_READINGS`, `LOG`, the volume code of the shapes on the site, the decoders of the family and `parseUplink`.
   - **Table**: the level → volume table of the tank you are editing (keyed by level, or by a sensor's reading), as CSV.
   - **Details**: every tank of the site described in plain words and numbers (Markdown), to give to an AI assistant or a colleague: shape and how it was measured, inside and outside sizes, each end with its depth, radii and plate, liquid and density, overflow and outlet levels, manholes, every sensor with its position, face height above the inside floor, blind zone, range, readable levels, calibration, script number and devices, a volume table every 5 % of the height, and the device list.

   Set the scripts up from top to bottom:
   1. **Sensors**: every ultrasonic, radar or laser sensor on the roof of every tank is one numbered entry (1, 2, 3… or any number up to 9999 you type). A tank with three sensors has three entries; a sensor on its own tank is one entry. Bottom sensors and switches are left out (the scripts read distance).
   2. **Devices**: paste the DevEUIs or IMEIs, one per line, with the sensor number after a comma if you like (`A84041F359618158, 3`, `866207058378443, 4`); lines without one take the number chosen below the box, or else the next sensor that has no device yet. They go into the scripts as soon as an address is complete, and the scripts change as you type (device rows, sensor numbers and variable ids too). Each device row has its sensor number. Several devices can share a number (identical tanks).
   3. **Variable type ids**: the platform's ids are filled in (mm 1380, % 1406, L 1371); change them only if your platform differs. Without a % or L id the Fill level or Volume endpoint is not made.
   4. Copy **Configuration** and **Payload** into the device model. They have no comments, so they paste as they are. Always paste both together after a change.

   What the scripts do:
   - Endpoints of a device with number n: `1` Distance (generic sensor, mm): the sensor's own reading, as it sends it; `2` Temperature (temperature sensor, °C), updated when the sensor reports one (Tekelek frames, JSON); `n1` Liquid level (mm); `n2` Fill level (%, one decimal); `n3` Volume (whole litres). The variable type ids 1380 (mm), 1406 (%) and 1371 (L) are emitted as constants at the top of the configuration script.
   - Each `TANKS` entry holds the sensor (`name`, `sensor`, `blindZone`, `maxRange`), its tank's sizes (`shape`, `insideDiameter`, `shellHeight`, `bottom` / `top` or `leftEnd` / `rightEnd` with their depth and radii, wall and end plates) and `sensorHeight`: the sensor face above the inside floor of the tank. The level is `sensorHeight − distance + levelOffset` (`levelOffset` comes from a field calibration, 0 from the drawing), kept between the floor and the top.
   - A sensor **on a manhole** has a `manhole` block in its entry instead of a fixed `sensorHeight`, with the manhole's own sizes: `shape` and `insideDiameter` (or `insideWidth` × `insideLength`), `roofHeight` (the inside roof under the manhole centre above level zero; the wall top on a concrete storage), `roofThickness`, `neckHeight` (outside roof to the top of the cover), `coverThickness` and `sensorAboveCover`. The script adds up the sensor height as `roofHeight + roofThickness + neckHeight + sensorAboveCover`. When the level is above `roofHeight` the liquid stands in the neck: the script adds that column with the area of the opening (not of the tank), up to the underside of the cover, shows the level up to there, keeps the fill level at 100 % and says in the log how many litres are in the neck. On a tilted tank the block also carries `tilt`, and the column is measured along the neck.
   - The volume is computed from the sizes: standing and lying cylinders with flat, hemispherical, ellipsoidal, dished, torispherical, flanged, conical, toriconical or paraboloidal ends, spheres, and boxes. Other shapes (tilted, tapered, oval, polygon…) carry a compact `level` → `litres` table instead, and the dialog says so. A concrete storage is `shape: "concretePit"` with `maxLevel` (the wall top above the deepest point), `fullLitres` and `table`: the level → litres pairs every 10 mm (50 mm when the script would grow past about 50 kB), which the script interpolates. Only the volume functions of the shapes on the site are emitted.
   - The decoder finds the sensor model from each uplink. LoRaWAN model: Dragino MR-03 / MR-12 / MR-25-LB radar and DDS20 / DDS45 / DDS75-LB / LDDS ultrasonic (FPORT 2, 3, 5), Rochester / Tekelek TEK 766 (frames 10, 30, 45, as in the TEK 766 user manual V1.3: ullage in cm × 10, temperature byte, SRC / SRSSI nibbles, alarm limits, status with battery and RSSI), Milesight EM310-UDL / EM400-UDL / MUD / EM410-RDL / EM500-UDL (FPORT 85), Netvox R718X / R718PE (FPORT 6), and anything a network server (TTN payload formatter, ChirpStack) has decoded to a `distance` in mm or an `ullage` / `distance_cm` in cm. TCP model: Rochester / Tekelek TEK 811 / 811 LR / 822 (binary or hex text, manual 9-5987-03: IMEI in bytes 7–14, ullage in cm), the newer Tekelek cellular frame (IMEI in bytes 9–16, CRC-16/XMODEM in the last two bytes, 6-byte readings from byte 46: temperature byte, SRC / SRSSI nibbles, ullage in mm; the newest reading with data is used; there is no public manual for it, so the layout was read from frames a sensor sent, and its battery is not reported) and JSON text from SIM card devices. Both go through the same level and volume pipeline.
   - A reading the sensor itself marks bad (Dragino sensor flag, Tekelek `MIN_SRC` 8 and `MIN_SRSSI` 4 with the SRC meaning in the log, Milesight no-target / error codes), one in the blind zone, one past the range, or one more than 100 mm below the floor is still shown on Distance (`SHOW_ALL_READINGS = true`) but never changes the level, % or volume; the log says `INVALID` and the reason. Set `SHOW_ALL_READINGS` to false to keep such readings off Distance too.
   - A device that is not in `DEVICE_TANKS` gets its reading on `1` only, with a log line saying to add it.
   - The scripts are plain ES5 (`var`, `function`, `for`) with no comments, as the platform runs them.

   The tanks, the sensor numbers and the devices are saved with the site and in the project file. Sites saved before keep their tank number as the number of the tank's first distance sensor.

   The tests run the generated payload script on every library tank and storage and on 25 tanks checked against textbook formulas, and check that level and volume match the 3D tank. The configuration script is checked line by line against the customer layout, and `tests/acceptance.test.ts` runs the Asphalt Storage 7 + 8 example through the acceptance checks above for both sensor families.

10. **Save the project file.** **File → Save** (Ctrl+S) writes one `.tank.json` file with everything you set, for every tank of the site: shape, sizes, walls, tilt, liquid, levels, sensors, outputs, calibration points, units, 3D view, simulated levels, devices and export choices, plus a short read-only summary of the tank you are editing in plain numbers. In Chrome and Edge, Save writes the same file again; other browsers download a copy. Open it with **File → Open** (Ctrl+O) or drop it on the page. The **Guide** button walks through all steps with checks on your tank.

Every section has a **?** line with a short explanation and examples.

## What the numbers mean

- **Level zero** is the lowest inside point of the tank. All levels are measured straight up from it.
- **Face height** is where a top sensor's face sits above level zero. On a domed or conical roof it depends on where the sensor is placed, plus the roof thickness and any nozzle. On a manhole it is the top of the cover plus the sensor height. The app warns when the sensor is off the opening or its beam is wider than the opening where it leaves the neck.
- A top sensor reads **distance**; level = face height − distance (× cos tilt when the tank is tilted). A pressure sensor reads **pressure**; level = sensing-point height + pressure ÷ (density × g).
- **Valid levels** are where a sensor gives a usable reading. A top sensor cannot measure inside its dead band, past its range, or below the floor directly under it (for example over a cone bottom). A pressure sensor reads zero until the liquid reaches its sensing point.
- Each sensor's formula maps the raw value your script reads (distance, pressure, mA, V or ADC counts) to level: `level = A + B × raw`. Then look up the volume in the level → volume table with linear interpolation.

## How the volume is computed

Every cross-section of the tank is a circle, ellipse, rounded rectangle or convex outline (polygon, trapezoid, D-shape, box-oval and the other flat-and-round shapes), scaled and shifted along the tank axis. The wetted area of such a section cut by a straight surface line has an exact formula (curved outlines are traced with over a thousand points, which keeps them within a few parts per million), so the volume at any level is the integral of that area along the axis, done with Gauss–Legendre quadrature split at every point where the profile or the surface changes. The tests compare it with textbook formulas (vertical and horizontal cylinders with hemispherical, 2:1 elliptical and conical ends, spheres, boxes, frustums, elliptical road-tanker shells) and agree to about one part per million, and check tilted tanks against an independent column integration.

A concrete storage is sampled on a grid over its plan (at least 500 cells across the longer side, doubled until the capacity changes by less than 0.05 %). Each cell centre inside the walls is a column of liquid from the floor up; the floor is a plane, or a piecewise-linear surface over a Delaunay triangulation of the corner heights, with sumps cut in; the columns of each region are weighted so they add up to its exact plan area. The volume at a level is the sum of the columns below it, found with one binary search, so the curve is exact for flat floors and matches the wedge + prism formula of a sloped floor to a few parts in 10⁵; the tests check a sloped floor, a sump and a ridge against closed forms.

## Project layout

```
src/core/      tank model, shapes (incl. polygons), head profiles, volume engine, concrete storages (pit.ts, polygon.ts), sensor physics, calibration tables, field calibration, presets
src/export/    configuration and payload scripts (cloudstudio.ts), sensor decoders by family (csDecoders.ts), table / CSV and the project file
src/three/     3D geometry (shell with wall thickness, cut-away sections, liquid; concrete storages in pitGeometry.ts) and the viewer
src/ui/        panels (tank and concrete storage designers), sight glass, chart, plan view, export dialog
src/app/       state store, colours, local storage, file save / open
tools/         Cloud Studio test harnesses for the generated scripts (LoRaWAN and TCP)
tests/         vitest suites, including the script acceptance tests
```

## Limits

- Internal parts (pipes, heating coils, ladders, baffles) are not subtracted from the volume, and the app's own volumes, tables and capacity stop at the top of the tank or the wall top: the space inside a manhole neck is not part of them. Only the Cloud Studio payload script adds the liquid standing in the neck, for a sensor that sits on that manhole.
- Tilt is about one axis: vertical tanks lean left–right, horizontal tanks slope along their length.
- Standard torispherical heads follow their standards: the crown and knuckle radii are inside radii, given as fractions of the outside diameter of the head (inside diameter + 2 × plate), so a Klöpper head is h2 = 0.1935 Da − 0.455 s deep as in DIN 28011. Dome and semi-ellipsoidal heads are defined on the inside diameter (a 2:1 head is ID / 4 deep inside). If your drawing gives the inside depth of a head, choose **Inside** measurements or enter the depth directly.
- The last tank is also kept in the browser's local storage. Use **File → Save** to keep a real file you can copy or send.
- Polygon bodies are regular polygons stretched to the width × depth you type. With outside measurements across corners (6 and 10 sides) the wall is removed along the corner direction.
- Field calibration is a straight-line correction. It cannot fix a wrong tank shape: if the multi-point errors grow in one part of the tank, check the sizes and end shapes.
