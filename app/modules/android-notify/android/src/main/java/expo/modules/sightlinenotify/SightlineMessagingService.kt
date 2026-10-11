package expo.modules.sightlinenotify

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.enums.NotificationPriority
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.triggers.ChannelAwareTrigger
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.NotificationsService
import expo.modules.wgtunnel.SharedStore
import org.json.JSONObject
import java.util.Date
import java.util.UUID

/**
 * Expo's push service, plus Sightline Hub pushes.
 *
 * The Hub sends Android phones data-only pushes (bridge/push.go forDevice) so they always
 * reach this service, even with the app in the background or closed; a push with a title
 * would be drawn by Android itself, without action buttons or the snapshot. This turns one
 * into an ordinary expo-notifications notification (same identifier, data, category and
 * channel as on iOS), so taps and buttons reach the app's response listener exactly like
 * local notifications, and SightlinePresentationDelegate adds the decrypted snapshot.
 *
 * Anything that isn't a Sightline push, or that fails to parse, goes to Expo unchanged.
 */
class SightlineMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val notification = try {
      SightlinePush.toNotification(this, remoteMessage)
    } catch (t: Throwable) {
      Log.w(TAG, "Could not read a Sightline push", t)
      null
    }
    if (notification == null) {
      super.onMessageReceived(remoteMessage)
      return
    }
    // In the foreground the app's JS handler decides how to show it; otherwise Expo presents
    // it because it has a title (ExpoHandlingDelegate.handleNotification).
    NotificationsService.receive(this, notification)
  }

  companion object {
    private const val TAG = "SightlineNotify"
  }
}

internal object SightlinePush {
  // Keep in sync with bridge/push.go.
  const val MARKER = "slPush"
  const val TITLE = "slTitle"
  const val BODY = "slBody"
  const val CHANNEL = "slChannel"
  const val CATEGORY = "slCategory"
  const val ENC = "enc"
  const val MSG_KEY = "bridge.msgKey"
  const val THUMB_KEY = "bridge.secret"

  /**
   * The push's own data. Through Expo's push service it arrives as JSON in the FCM "body"
   * field; a message sent straight through FCM would carry the keys at the top level.
   */
  fun dataOf(message: RemoteMessage): JSONObject? {
    val fcm = message.data
    if (fcm[MARKER] == "1") return JSONObject(fcm)
    val body = fcm["body"] ?: return null
    val json = try {
      JSONObject(body)
    } catch (e: Exception) {
      return null
    }
    return if (json.optString(MARKER) == "1") json else null
  }

  /**
   * End-to-end encrypted messages (bridge/seal.go): enc is the sealed flat JSON of the real
   * fields ({"v":"1","title","body","threadId", plus the data keys}), opened with
   * SHA256("sightline-msg-v1:" + key) and merged over the visible data, title/body onto
   * slTitle/slBody. The key is the per-phone message key when the app has stored one
   * ("bridge.msgKey"), else the thumbnail key. The app advertises caps ["enc-msg-v1"], so
   * updated Hubs send Android phones only generic visible text (bridge/seal_test.go
   * TestSealedAndroidDataOnly mirrors this merge).
   */
  fun openSealedMessage(context: Context, data: JSONObject) {
    val enc = data.optString(ENC)
    if (enc.isEmpty()) return
    val keys = listOfNotNull(SharedStore.get(context, MSG_KEY), SharedStore.get(context, THUMB_KEY))
    for (key in keys) {
      val plain = ThumbCrypto.open(enc, key, ThumbCrypto.MESSAGE) ?: continue
      val sealed = try {
        JSONObject(String(plain, Charsets.UTF_8))
      } catch (e: Exception) {
        return
      }
      for (k in sealed.keys()) data.put(k, sealed.get(k))
      if (!sealed.has(TITLE) && sealed.has("title")) data.put(TITLE, sealed.optString("title"))
      if (!sealed.has(BODY) && sealed.has("body")) data.put(BODY, sealed.optString("body"))
      data.remove(ENC)
      return
    }
  }

  fun toNotification(context: Context, message: RemoteMessage): Notification? {
    val data = dataOf(message) ?: return null
    openSealedMessage(context, data)
    // A sealed message that couldn't be opened still says something happened.
    val title = data.optString(TITLE).ifEmpty { context.applicationInfo.loadLabel(context.packageManager).toString() }
    val text = data.optString(BODY)
    val channel = data.optString(CHANNEL).ifEmpty { null }
    val category = data.optString(CATEGORY).ifEmpty { null }
    val content = NotificationContent.Builder()
      .setTitle(title)
      .setText(text.ifEmpty { null })
      .setBody(data)
      .setPriority(if (channel == "doorbell") NotificationPriority.MAX else NotificationPriority.HIGH)
      .useDefaultSound()
      .useDefaultVibrationPattern()
      .setAutoDismiss(true)
      .setCategoryId(category)
      .build()
    val identifier = message.data["tag"] ?: message.messageId ?: UUID.randomUUID().toString()
    val request = NotificationRequest(identifier, content, ChannelAwareTrigger(channel))
    val sent = if (message.sentTime > 0) Date(message.sentTime) else Date()
    return Notification(request, sent)
  }
}
