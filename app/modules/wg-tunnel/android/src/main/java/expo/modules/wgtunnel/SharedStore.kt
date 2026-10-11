package expo.modules.wgtunnel

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android counterpart of ios/SharedKeychain.swift: small secrets (bridge secret / URL) that
 * notification handling reads outside the JS app. Stored in the app-private SharedPreferences
 * file "sightline.shared", AES-GCM encrypted with a non-exportable Android Keystore key, so a
 * backup restored onto another phone can't read them ("this device only", like iOS).
 * Read with SharedStore.get(context, name) from any code in the app process.
 */
object SharedStore {
  private const val PREFS = "sightline.shared"
  private const val KEY_ALIAS = "sightline.shared.v1"
  private const val TRANSFORM = "AES/GCM/NoPadding"

  @Synchronized
  fun set(context: Context, name: String, value: String) {
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    prefs(context).edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  @Synchronized
  fun get(context: Context, name: String): String? {
    val stored = prefs(context).getString(name, null) ?: return null
    return runCatching {
      val sealed = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
      String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)
    }.getOrNull()
  }

  @Synchronized
  fun remove(context: Context, name: String) {
    prefs(context).edit().remove(name).apply()
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }
}
