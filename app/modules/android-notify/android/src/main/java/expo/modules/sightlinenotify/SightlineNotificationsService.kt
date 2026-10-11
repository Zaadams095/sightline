package expo.modules.sightlinenotify

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.util.Log
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate
import expo.modules.wgtunnel.SharedStore

/**
 * expo-notifications' broadcast receiver with a presenter that adds a picture. Registered
 * with a higher priority than Expo's own, so Expo routes its work here (see the manifest).
 */
class SightlineNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate =
    SightlinePresentationDelegate(context)
}

/**
 * Builds the notification exactly as Expo does (title, text, channel, action buttons, tap
 * handling), then, when the notification's data has a picture, shows it big:
 *  - `thumb`: the Hub's encrypted inline snapshot (bridge/thumb.go), opened with the key
 *    the app stored in wg-tunnel's SharedStore (the Android twin of the iOS shared Keychain);
 *  - `androidImage`: a file:// URI of a snapshot the app downloaded (built-in alerts).
 * Any failure leaves Expo's text notification as it was.
 */
class SightlinePresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  override suspend fun createNotification(
    notification: Notification,
    notificationBehavior: NotificationBehaviorRecord?
  ): android.app.Notification {
    val base = super.createNotification(notification, notificationBehavior)
    return try {
      val picture = pictureFor(notification) ?: return base
      withPicture(base, picture)
    } catch (t: Throwable) {
      Log.w(TAG, "Showing the notification without its picture", t)
      base
    }
  }

  private fun pictureFor(notification: Notification): Bitmap? {
    val data = notification.notificationRequest.content.body ?: return null
    val thumb = data.optString("thumb")
    if (thumb.isNotEmpty()) {
      // Written by the app through WgTunnel.setShared (app/src/alerts/bridge.ts bridgeSecret).
      val secret = SharedStore.get(context, "bridge.secret") ?: return null
      val jpeg = ThumbCrypto.open(thumb, secret) ?: return null
      return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
    }
    val image = data.optString("androidImage")
    if (image.isNotEmpty()) {
      val path = Uri.parse(image).path ?: return null
      return decodeSampled(path, MAX_SIDE)
    }
    return null
  }

  private fun withPicture(base: android.app.Notification, picture: Bitmap): android.app.Notification {
    val builder = android.app.Notification.Builder.recoverBuilder(context, base)
    val style = android.app.Notification.BigPictureStyle()
      .bigPicture(picture)
      // Expanded: the big picture replaces the small one on the right.
      .bigLargeIcon(null as Icon?)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      style.showBigPictureWhenCollapsed(true)
    }
    builder.setLargeIcon(picture)
    builder.setStyle(style)
    return builder.build()
  }

  /** Decodes a downloaded snapshot at most `maxSide` pixels on its long side. */
  private fun decodeSampled(path: String, maxSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
  }

  companion object {
    private const val TAG = "SightlineNotify"
    private const val MAX_SIDE = 1024
  }
}
