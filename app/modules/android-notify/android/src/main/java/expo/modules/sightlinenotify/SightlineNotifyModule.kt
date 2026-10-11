package expo.modules.sightlinenotify

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * No JS API: this module exists for its push service and notification presenter (see the
 * manifest). The thumbnail key comes from wg-tunnel's SharedStore ("bridge.secret").
 */
class SightlineNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SightlineNotify")
  }
}
