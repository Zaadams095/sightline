package expo.modules.sightlinenotify

import android.util.Base64
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opens the Hub's end-to-end sealed push fields: base64(nonce(12) || ciphertext || tag(16)),
 * AES-256-GCM with key SHA256(label + secret).
 *  - THUMB ("sightline-thumb-v1:"): the inline snapshot, same as bridge/thumb.go openThumb
 *    and the iOS NotificationService.openThumb.
 *  - MESSAGE ("sightline-msg-v1:"): `data.enc`, the encrypted title/body/data for phones that
 *    advertise `enc-msg-v1` (see SightlinePush.openSealedMessage).
 */
internal object ThumbCrypto {
  const val THUMB = "sightline-thumb-v1:"
  const val MESSAGE = "sightline-msg-v1:"
  private const val NONCE = 12

  fun open(b64: String, secret: String, label: String = THUMB): ByteArray? = try {
    val raw = Base64.decode(b64, Base64.DEFAULT)
    if (raw.size <= NONCE + 16) {
      null
    } else {
      val key = MessageDigest.getInstance("SHA-256").digest((label + secret).toByteArray(Charsets.UTF_8))
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, NONCE))
      cipher.doFinal(raw, NONCE, raw.size - NONCE)
    }
  } catch (t: Throwable) {
    null
  }
}
