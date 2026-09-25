# Troubleshooting the pit and the probes

## Reading the Smoke Signal report

- **Pit** is an ambient sensor.
  - On the INT-12-BW it's the black probe's handle, measuring the air right next to the meat.
  - It usually reads lower than a lid thermometer, and it swings more when the lid opens.
  - It can read low while the meat is cold at the start, or when it's tucked against the meat.
- **Rates** are robust trends in degrees per hour. Recovered lid-open dips are excluded from the
  pit trends.
  - **15 min**: early warning, but noisy.
  - **30 min**: the main signal.
  - **60 min**: the big picture.
- **ETA** is straight-line: it assumes the current rate continues.
  - It's pessimistic before the stall and meaningless during it, so the report says so.
  - After wrapping, rates usually jump.
  - Use it for "are we roughly on time", and plan with the cut's typical times from `meats.md`.
- **Dips**: a sharp drop of 10°C (18°F) or more within 3 minutes that recovers is a lid opening,
  spritz or mop. It's normal. Many of them, or slow recoveries, cost time.

## Pit too low, or falling

Check in this order:

1. **Lid, door and firebox closed?** A lid left cracked is the most common cause.
2. **Fuel?** It depends on the cooker:

   | Cooker | Most likely cause | Fix |
   |---|---|---|
   | Offset / stick burner | The fire is burning down between splits | Add one or two pre-warmed splits; keep a bright, clean fire. Rake the coals together and clear ash from under the grate |
   | Charcoal (kettle, WSM, UDS) | The lit coals are running out, or ash is choking the fire | Open the bottom intake more (keep the top vent at least half open). Stir or knock the ash through. Add lit coals from a chimney if the fire has burned down |
   | Kamado | Too little air | Open the bottom vent a little, wait 10–15 min, then adjust again. Kamados respond slowly, so small moves |
   | Pellet grill | The hopper is empty or the pellets have bridged/tunnelled, starving the auger | Check and stir the hopper. If the temperature keeps falling toward ambient, the fire may have gone out: follow the grill's shutdown and restart procedure. Never restart with a pile of unburned pellets in the fire pot, as it can flare dangerously |
   | Electric / gas | Element tripped, or a gas bottle running empty | Check power and the propane level |
   | Oven | Door ajar, wrong setting | Check the setting |

3. **Weather.** Wind, rain and cold can pull 25–75°F. Block the wind, and expect to burn more
   fuel.
4. **After fixing**, the pit should turn around within 10–15 min (kamado and ceramic cookers
   take longer). Re-check next time; if it's still dropping, escalate.

A **falling pit with the meat still under 140°F**, 3–4 h into the cook, is the urgent case.

## Pit too high

- Close the **intake** partway. Keep the exhaust at least half open, because a choked exhaust
  makes bitter, sooty smoke.
- Don't add fuel. On an offset, let the fire burn down a little and use smaller splits.
- Pellet or electric: check the set point. A sudden spike on a pellet grill can be a grease fire
  (visible flames, thick smoke). Close the lid and turn the grill off.
- Opening the lid to dump heat works briefly, but it spikes an offset back up (a fresh burst of
  oxygen).
- **Big collagen cuts forgive 275–300°F** for a while. Lean roasts and poultry skin don't.

## Oscillating pit (±20°F cycles)

- Offset: add smaller splits more often; keep a coal bed.
- Charcoal / kamado: you're over-correcting the vents. Make small moves and wait 15 min between
  them.

## The stall

- Evaporative cooling: moisture on the surface cools the meat about as fast as the pit heats
  it.
- Typically 150–170°F. It lasts 2–6 h on a big brisket or pork butt, and can even dip a degree
  or two.
- Options, all valid:
  1. Ride it out: best bark, slowest.
  2. Wrap in butcher paper: keeps most of the bark, moderate speed-up.
  3. Wrap in foil (the "Texas crutch"): fastest, softest bark, add a splash of liquid.
  4. Raise the pit 25°F.
- Choose based on how the serve time compares with the projection.
- After wrapping, call `log_event` ("wrapped in paper").

## Probe problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Meat reading jumps up fast, or is much hotter than the other probe in the same cut | Tip in a fat pocket, touching bone, or poking through into air | Re-seat into the thickest lean part; confirm with an instant-read thermometer |
| Meat reads higher than the pit | Probe partly out of the meat or through it; ambient sensor in shade or wrapped in foil | Re-seat it; make sure the handle (ambient sensor) is out in the air, not buried in foil |
| Meat falling mid-cook with the pit fine | Probe moved, or the meat was taken out | Ask what happened; re-seat |
| NO SIGNAL / signal lost | Probe out of the base's range, blocked by metal, or its battery is flat | Move the base closer (within a few metres, line of sight to the cooker helps). Charge the probe in the base for a few minutes if its battery is low |
| "Docked" | The probe is in the base charging, not measuring | Take it out and insert it into the meat |

## INT-12-BW specifics

- One base station connects to the Mac over Bluetooth. The two wireless probes talk to the base.
- **Only one Bluetooth app at a time.** While Smoke Signal holds the connection, the INKBIRD phone
  app can't use Bluetooth. It may still work over Wi-Fi if the base is on Wi-Fi.
- If nothing connects:
  - Fully close the INKBIRD app.
  - Wake the base by taking out a probe or pressing its button.
  - Check that the Mac is nearby.
- **Insertion.** Push each probe in past the safety line, so the tip sensor is in the meat and
  the handle (ambient sensor on the black probe) is in the air. Keep handles out of direct
  flame; the ambient sensor has a maximum temperature rating.
- **Batteries.** The report shows the base and probe batteries. Charge the probes fully before a
  long cook.
