# New Maps and Pins Restructure and cleanup

## Problems we are addressing:

* Take the search box and its associated specific text off the top of the main page. 
* get rid of the Drop Pin button (cleaning up)
* Combine all pin functions (drop a pin and search) under a New Pin dialog

## requirements:

* clear and simple; lots of guidance without lots of text. Less clutter, more clarity
Every dialog has a name, every control has a label and edit boxes also have instructional text, every button and menu option has on hover text.
* Easy to start a new map
* easy to add a pin to my current map through search or pin dropping

## solution

* Drop Pin dialog becomes "New Pin" dialog. Edit box still populates with local suggestions. Edit field is labeled as "Pin Name:"; Instructional static text: "Name a pin here, or search for a location elsewhere on this map." Now has buttons: Drop Pin Here, and Search. Search results in the old behavior of either adding a pin or saying it's too far away, etc. Default button is "Drop Pin Here" -- pressing Enter in the edit field drops a named pin at the cursor, same as today's Custom POI dialog; searching requires explicitly tabbing to the Search button. This is intentional.
* A "New Map" dialog that takes a search string and builds a new map centered on the resulting pin, replacing the current map. Edit is labeled: "New map location:"; Instructional text: "Search for a location. The new map will be centered there." If there *is* a current map, append the instructional text, "The current map will be added to your history."

## Design and strings

* , when the page first launches (no current map), there's only a New Map button. When a current map exists, there is a "new" menu with items "New Map", and "New Pin" navigable by arrow keys, and with hotkeys. On-hover text is provided elsewhere.
* Instructional text on the main page: If no current map, "Search for an address or location to get started" If there is a current map, instructional text "disappears to make more room for the map. 

* n is mapped to New Map. a continues to be mapped to New Pin, quietly -- not documented. p is also mapped to New Pin and is the documented hotkey.
* Hover text for buttons:
** New Map -- "Search: Open a map centered on a new location."
** New Pin -- "Mark a new location on this map."
** (inside New Pin) Drop Pin Here -- "Enter a name and drop it"
** (inside New Pin) Search -- "Search: Put a pin on this map at a new location"

## Dot Pad

No Dot Pad key combo for New Map or New Pin. Both require text entry, and text entry isn't possible from the device -- the QWERTY keyboard is required either way -- so there's nothing for a device-side combo to trigger. Intentional, not an oversight.

## Big Questions:

* Would this be a good time to think about returning suggestions instead of a single unilateral search decision? (Filed as tmap issue #14.)
* would this be a good time to replace pure distance checking for new pins on the current map and replace it with hit testing instead? (Filed as tmap issue #15.)
