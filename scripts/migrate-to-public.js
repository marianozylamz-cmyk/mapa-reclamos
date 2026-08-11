const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
    const snapshot = await db.collection('reclamos').get();

    let count = 0;
    const batch = db.batch();

    snapshot.forEach((docSnap) => {
        const data = docSnap.data();

        if (data.status !== 'approved' && data.status !== 'solved') return;

        const publicRef = db.collection('reclamos_publicos').doc(docSnap.id);

        batch.set(publicRef, {
            claimId: data.claimId || null,
            title: data.title || '',
            category: data.category || 'otro',
            address: data.address || '',
            description: data.description || '',
            lat: data.lat,
            lng: data.lng,
            photo: data.photo || null,
            status: data.status,
            adhesions: data.adhesions || 0,
            createdAt: data.createdAt || null
        });

        count++;
    });

    if (count === 0) {
        console.log('No había reclamos aprobados/solucionados para migrar. Nada que hacer.');
        return;
    }

    await batch.commit();
    console.log(`✅ Migración completa. ${count} reclamos copiados a reclamos_publicos.`);
}

migrate()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error en la migración:', error.message);
        process.exit(1);
    });
