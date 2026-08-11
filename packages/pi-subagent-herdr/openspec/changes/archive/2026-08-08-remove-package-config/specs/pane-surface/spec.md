# Capability: pane-surface

## MODIFIED Requirements

### Requirement: attached stack layout

Every admitted run SHALL open a real Herdr pane or tab and SHALL default to attached layout with direction `right` when per-call options are omitted: the first child splits the caller right and subsequent children split the tallest region pane down.
When a call explicitly sets `direction: down`, the first child splits the caller down and subsequent children split the widest region pane right.
Geometry SHALL be preferred, with deterministic depth/insertion-order fallback.
Package config SHALL NOT supply layout or direction defaults.

#### Scenario: first admitted run

- **WHEN** an admitted run finds an empty attached region and omits layout/direction
- **THEN** it splits the caller right using Herdr's default even split

#### Scenario: children stack on inverse axis

- **WHEN** up to five active runs occupy one parent region under the default `right` direction
- **THEN** subsequent admitted runs split the selected region pane down with deterministic tie-breaking

#### Scenario: geometry unavailable

- **WHEN** `pane layout` rectangles are unavailable
- **THEN** the shallowest tracked pane is selected, ties use insertion order, and growth remains deterministic

#### Scenario: minimum size fallback

- **WHEN** the prospective attached target is below the documented useful size
- **THEN** that admitted run opens in a tab and the acknowledgement/result reports the fallback

#### Scenario: empty region reset

- **WHEN** every region pane is settled or manually closed
- **THEN** region state resets and the next admitted run splits the caller anew

### Requirement: surface options

The extension SHALL support per-call `layout: attached|single`, `surface: pane|tab`, and `direction: right|down` for `subagent` and `subagent_resume`.
When omitted, effective values SHALL be `layout: attached`, `surface: pane`, and `direction: right`.
Package-level config SHALL NOT set these values.
A conflicting direction SHALL NOT silently mutate a nonempty attached region.

#### Scenario: omitted surface options use code defaults

- **WHEN** a call omits `layout`, `surface`, and `direction`
- **THEN** the run uses attached layout, pane surface, and right-then-down stacking

#### Scenario: explicit tab

- **WHEN** `surface: tab` is effective
- **THEN** the child is created with the Herdr no-focus tab path

#### Scenario: single split

- **WHEN** `layout: single` is effective
- **THEN** the run gets one split of the caller and is not added to attached-region stacking geometry

#### Scenario: direction conflict

- **WHEN** a call requests a direction different from a nonempty region's direction
- **THEN** it waits for that region to empty or uses a documented isolated surface path rather than silently ignoring the request
