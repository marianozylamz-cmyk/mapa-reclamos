/**
 * set-admin-claim.js
 * -------------------
 * Corré esto UNA SOLA VEZ para convertir a tu usuario en admin real
 * (verificado por Firebase, no por un string en el JS público).
 *
 * CÓMO USARLO:
 * 1. Poné el archivo de la cuenta de servicio (el .json que bajaste de
 *    Firebase Console → ⚙️ Configuración del proyecto → Cuentas de servicio
 *    → Generar nueva clave privada) en esta misma carpeta "scripts",
 *    y renombralo a "service-account.json".
 *    ¡OJO! Ese archivo es un secreto real. No lo subas a git. Ya te dejo
 *    un .gitignore en esta carpeta que lo excluye.
 *
 * 2. Instalá las dependencias (una vez):
 *      cd scripts
 *      npm install
 *
 * 3. Conseguí el UID de tu usuario admin:
 *      Firebase Console → Authentication → Users → columna "User UID"
 *      (es el usuario que creaste con email/contraseña en el paso 2 del plan)
 *
 * 4. Corré el script pasándole ese UID:
 *      node set-admin-claim.js TU_UID_ACA
 *
 * 5. Deberías ver: "✅ Listo. El usuario TU_UID_ACA ahora es admin."
 *
 * 6. Verificación: entrá al sitio, hacé login con ese email/contraseña,
 *    y confirmá que aparece el panel admin. Si no aparece, cerrá sesión
 *    y volvé a entrar (el token viejo no tiene el claim nuevo hasta que
 *    se renueva).
 */

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

const uid = process.argv[2];

if (!uid) {
    console.error('❌ Falta el UID. Uso: node set-admin-claim.js TU_UID_ACA');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

admin.auth().setCustomUserClaims(uid, { admin: true })
    .then(() => {
        console.log(`✅ Listo. El usuario ${uid} ahora es admin.`);
        console.log('   Cerrá sesión y volvé a entrar en el sitio para que el cambio tome efecto.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Error seteando el custom claim:', error.message);
        process.exit(1);
    });