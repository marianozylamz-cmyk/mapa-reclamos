const OLAVARRIA_LAT = -36.8927;
const OLAVARRIA_LNG = -60.3225;
const OLAVARRIA_BOUNDS = {
    minLat: -36.99,
    maxLat: -36.75,
    minLng: -60.52,
    maxLng: -60.05
};
const ADMIN_CODE = 'varilla';

const CATEGORIES = {
    plazas: { label: 'Parques/Paseos/Plazas' },
    salud: { label: 'Salud' },
    alumbrado: { label: 'Alumbrado' },
    calle: { label: 'Bache/Calle/Camino' },
    basura: { label: 'Basura' },
    otro: { label: 'Otros' }
};

const state = {
    claims: [],
    map: null,
    markers: [],
    isAdmin: false,
    selectedCategory: null,
    currentLocation: null,
    currentPhoto: null,
    activeCategoryFilter: 'all',
    mapClickLocation: null
};

document.addEventListener('DOMContentLoaded', async () => {
    checkAdminAccess();
    await loadFirebaseData();
    initLeafletMap();
    setupApplicationEvents();
    renderPublicClaimsList();
    initPoliticalCounter();
    handleDeepLinking();
});

function checkAdminAccess() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') === ADMIN_CODE) {
        state.isAdmin = true;
        document.getElementById('adminSessionBar').style.display = 'flex';
    }
}

function handleDeepLinking() {
    const params = new URLSearchParams(window.location.search);
    const claimId = params.get('claim');
    
    if (claimId) {
        const claim = state.claims.find(c => c.claimId === claimId && c.status === 'approved');
        if (claim) {
            setTimeout(() => {
                if (state.map) {
                    state.map.setView([claim.lat, claim.lng], 16);
                }
                globalOpenDetailWindow(claim._fbId);
            }, 500);
        }
    }
}

function isWithinOlavarria(lat, lng) {
    return lat >= OLAVARRIA_BOUNDS.minLat &&
           lat <= OLAVARRIA_BOUNDS.maxLat &&
           lng >= OLAVARRIA_BOUNDS.minLng &&
           lng <= OLAVARRIA_BOUNDS.maxLng;
}

function initLeafletMap() {
    state.map = L.map('map', { zoomControl: false }).setView([OLAVARRIA_LAT, OLAVARRIA_LNG], 14);
    L.control.zoom({ position: 'bottomleft' }).addTo(state.map);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(state.map);

    const bounds = [[OLAVARRIA_BOUNDS.minLat, OLAVARRIA_BOUNDS.minLng], 
                    [OLAVARRIA_BOUNDS.maxLat, OLAVARRIA_BOUNDS.maxLng]];
    L.rectangle(bounds, { color: '#cbd5e1', weight: 2, fillOpacity: 0.05, dashArray: '5, 5' }).addTo(state.map);

    state.map.on('click', (e) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        if (!isWithinOlavarria(lat, lng)) {
            alert('⚠️ Solo puedes crear reclamos dentro del partido de Olavarría');
            return;
        }

        state.mapClickLocation = { lat, lng };
        showMapClickModal(lat, lng);
    });

    renderMapPins();
}

function showMapClickModal(lat, lng) {
    const indicator = document.getElementById('mapClickIndicator');
    if (indicator) indicator.remove();
    
    const overlay = document.getElementById('mapClickOverlay');
    document.getElementById('clickCoords').textContent = `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    overlay.classList.remove('hidden');

    document.getElementById('confirmMapClick').onclick = () => {
        state.currentLocation = { lat, lng };
        overlay.classList.add('hidden');
        openClaimModal();
    };

    document.getElementById('cancelMapClick').onclick = () => {
        overlay.classList.add('hidden');
        state.mapClickLocation = null;
    };
}

function setupApplicationEvents() {
    document.getElementById('newClaimBtn').addEventListener('click', () => {
        state.currentLocation = null;
        state.selectedCategory = null;
        state.currentPhoto = null;
        openClaimModal();
    });
    
    document.getElementById('closeModal').addEventListener('click', closeClaimModal);
    document.getElementById('closeModalBtn').addEventListener('click', closeClaimModal);
    document.getElementById('closeDetail').addEventListener('click', () => {
        document.getElementById('detailPanel').classList.remove('visible');
    });

    const trigger = document.getElementById('recentClaimsTrigger');
    const popup = document.getElementById('recentClaimsPopup');
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.toggle('hidden');
    });
    document.getElementById('closeRecentPopup').addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.add('hidden');
    });

    document.getElementById('categoryFilterBar').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        state.activeCategoryFilter = btn.dataset.cat;
        renderMapPins();
        renderPublicClaimsList();
    });

    const categoriesOptions = document.querySelectorAll('#categoryGrid .category-option');
    categoriesOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            categoriesOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            state.selectedCategory = opt.getAttribute('data-value');
        });
    });

    document.getElementById('useGPS').addEventListener('click', triggerGPSCapture);
    document.getElementById('useMapClick').addEventListener('click', openMapClickModal);
    document.getElementById('photoDropZone').addEventListener('click', () => {
        document.getElementById('claimPhoto').click();
    });
    document.getElementById('claimPhoto').addEventListener('change', processPhotoFile);
    document.getElementById('removePhoto').addEventListener('click', clearPhotoEvidencia);
    document.getElementById('submitBtn').addEventListener('click', executeSubmitForm);

    document.getElementById('toggleDashBtn').addEventListener('click', () => {
        document.getElementById('adminPanel').classList.remove('hidden');
        syncAdminDashboard();
    });
    document.getElementById('closeDashBtn').addEventListener('click', () => {
        document.getElementById('adminPanel').classList.add('hidden');
        setTimeout(() => state.map.invalidateSize(), 200);
    });
    document.getElementById('exitSessionBtn').addEventListener('click', () => {
        window.location.href = window.location.pathname;
    });

    document.querySelectorAll('.admin-nav .nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.admin-nav .nav-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderAdminViewCards(e.target.dataset.section);
        });
    });

    document.getElementById('closeAdhesionModal').addEventListener('click', () => {
        document.getElementById('adhesionModal').classList.add('hidden');
    });
    document.getElementById('cancelAdhesion').addEventListener('click', () => {
        document.getElementById('adhesionModal').classList.add('hidden');
    });
}

function openClaimModal() {
    const modal = document.getElementById('claimModal');
    const hasLocation = state.currentLocation !== null;
    resetFormState(hasLocation);
    modal.classList.remove('hidden');
    
    if (state.currentLocation) {
        showLocationDisplay();
    }
}

function showLocationDisplay() {
    const locDisplay = document.getElementById('locationDisplay');
    if (state.currentLocation) {
        locDisplay.style.display = 'block';
        locDisplay.textContent = `✅ Ubicación: ${state.currentLocation.lat.toFixed(4)}, ${state.currentLocation.lng.toFixed(4)}`;
    }
}

function openMapClickModal() {
    const modal = document.getElementById('claimModal');
    modal.classList.add('hidden');
    
    const indicator = document.createElement('div');
    indicator.id = 'mapClickIndicator';
    indicator.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: white;
        padding: 24px;
        border-radius: 12px;
        box-shadow: 0 20px 25px rgba(0,0,0,0.3);
        z-index: 6000;
        text-align: center;
        font-weight: 600;
        color: #2d3135;
    `;
    indicator.innerHTML = `
        <p style="font-size: 16px; margin-bottom: 12px;">👆 Haz click en el mapa</p>
        <p style="font-size: 12px; color: #64748b;">Señala dónde está el problema</p>
        <button onclick="document.getElementById('mapClickIndicator').remove(); document.getElementById('claimModal').classList.remove('hidden');" 
                style="margin-top: 12px; padding: 8px 16px; background: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Cancelar</button>
    `;
    document.body.appendChild(indicator);
}

function closeClaimModal() {
    document.getElementById('claimModal').classList.add('hidden');
    const indicator = document.getElementById('mapClickIndicator');
    if (indicator) indicator.remove();
    state.currentLocation = null;
    state.selectedCategory = null;
    state.currentPhoto = null;
    document.getElementById('locationDisplay').style.display = 'none';
}

function resetFormState(preserveLocation = false) {
    document.getElementById('claimTitle').value = '';
    document.getElementById('claimName').value = '';
    document.getElementById('claimPhone').value = '';
    document.getElementById('claimAddress').value = '';
    document.getElementById('claimDescription').value = '';
    document.getElementById('locationDisplay').style.display = 'none';
    
    document.querySelectorAll('#categoryGrid .category-option').forEach(o => o.classList.remove('selected'));
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoDropZone').style.display = 'block';
    
    state.selectedCategory = null;
    if (!preserveLocation) state.currentLocation = null;
    state.currentPhoto = null;
}

function triggerGPSCapture() {
    if (!navigator.geolocation) {
        flashErrorMessage('Tu navegador no soporta GPS.');
        return;
    }

    document.getElementById('useGPS').disabled = true;
    document.getElementById('useGPS').textContent = '📍 Buscando ubicación...';

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            if (!isWithinOlavarria(lat, lng)) {
                flashErrorMessage('GPS fuera del partido de Olavarría. Ingresa la dirección manualmente.');
                document.getElementById('useGPS').disabled = false;
                document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
                return;
            }

            state.currentLocation = { lat, lng };
            const locDisplay = document.getElementById('locationDisplay');
            locDisplay.style.display = 'block';
            locDisplay.textContent = `✅ Ubicación capturada: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

            document.getElementById('useGPS').disabled = false;
            document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
        },
        (err) => {
            flashErrorMessage(`GPS error: ${err.message}`);
            document.getElementById('useGPS').disabled = false;
            document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
        }
    );
}

function processPhotoFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        flashErrorMessage('La imagen debe ser menor a 5MB');
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        state.currentPhoto = event.target.result;
        document.getElementById('photoImg').src = state.currentPhoto;
        document.getElementById('photoDropZone').style.display = 'none';
        document.getElementById('photoPreview').style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function clearPhotoEvidencia() {
    state.currentPhoto = null;
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoDropZone').style.display = 'block';
    document.getElementById('claimPhoto').value = '';
}

async function executeSubmitForm() {
    const title = document.getElementById('claimTitle').value.trim();
    const name = document.getElementById('claimName').value.trim();
    const phone = document.getElementById('claimPhone').value.trim();
    const address = document.getElementById('claimAddress').value.trim();
    const category = state.selectedCategory;
    const location = state.currentLocation;

    if (!title) return flashErrorMessage('Ingresa el título del reclamo');
    if (!category) return flashErrorMessage('Selecciona una categoría');
    if (!location) return flashErrorMessage('⚠️ Debes seleccionar ubicación: Usa GPS o señala en el mapa');
    if (!name) return flashErrorMessage('Ingresa tu nombre');
    if (!phone) return flashErrorMessage('Ingresa tu teléfono');
    if (!phone.startsWith('2284')) return flashErrorMessage('Teléfono debe empezar con 2284 (Olavarría)');

    const claimId = 'OLV-' + new Date().getFullYear() + '-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    
    const claimData = {
        id: Date.now(),
        claimId: claimId,
        name: name,
        email: '',
        title: title,
        category: category,
        urgency: 'normal',
        address: address || '',
        description: document.getElementById('claimDescription').value.trim(),
        lat: location.lat,
        lng: location.lng,
        photo: state.currentPhoto || null,
        phone: phone,
        status: 'pending',
        adhesions: 0,
        createdAt: new Date().toISOString()
    };

    try {
        const { collection, addDoc } = window.dbMethods;
        const docRef = await addDoc(collection(window.db, "reclamos"), claimData);

        claimData._fbId = docRef.id;
        state.claims.push(claimData);

        flashSuccessMessage('✅ Reclamo enviado correctamente');
        state.currentLocation = null;
        state.selectedCategory = null;
        state.currentPhoto = null;
        document.getElementById('claimModal').classList.add('hidden');
        renderMapPins();
        renderPublicClaimsList();

        if (state.isAdmin) syncAdminDashboard();

        setTimeout(() => {
            document.getElementById('formMessage').style.display = 'none';
        }, 3000);
    } catch (error) {
        console.error('Error al guardar:', error);
        flashErrorMessage('Error al guardar. Intenta nuevamente.');
    }
}

function flashErrorMessage(msg) {
    const el = document.getElementById('formMessage');
    el.textContent = msg;
    el.style.background = '#fee2e2';
    el.style.color = '#991b1b';
    el.style.display = 'block';
    return false;
}

function flashSuccessMessage(msg) {
    const el = document.getElementById('formMessage');
    el.textContent = msg;
    el.style.background = '#dcfce7';
    el.style.color = '#15803d';
    el.style.display = 'block';
}

function calculatePriority(adhesions) {
    if (adhesions >= 20) return 'urgente';
    if (adhesions >= 10) return 'prioritario';
    return 'normal';
}

function getPriorityLabel(adhesions) {
    if (adhesions >= 20) return 'Urgente';
    if (adhesions >= 10) return 'Prioritario';
    return 'Normal';
}

function getPrioritySvg(adhesions) {
    if (adhesions >= 20) return '<img src="priority-red.svg" class="priority-icon" alt="Urgente">';
    if (adhesions >= 10) return '<img src="priority-orange.svg" class="priority-icon" alt="Prioritario">';
    return '<img src="priority-yellow.svg" class="priority-icon" alt="Normal">';
}

async function addAdhesion(claimId) {
    const modal = document.getElementById('adhesionModal');
    modal.classList.remove('hidden');

    const handleSubmit = async () => {
        const name = document.getElementById('adhesionName').value.trim();
        if (!name) {
            alert('Ingresa tu nombre para adherir');
            return;
        }

        const claim = state.claims.find(c => c._fbId === claimId);
        if (!claim) return;

        try {
            claim.adhesions = (claim.adhesions || 0) + 1;

            const { doc, updateDoc } = window.dbMethods;
            const docRef = doc(window.db, "reclamos", claim._fbId);
            await updateDoc(docRef, {
                adhesions: claim.adhesions
            });

            document.getElementById('adhesionName').value = '';
            document.getElementById('adhesionModal').classList.add('hidden');

            renderPublicClaimsList();
            renderMapPins();
            globalOpenDetailWindow(claimId);

            alert('✅ ¡Gracias por tu adhesión!');
        } catch (error) {
            console.error('Error al adherir:', error);
            alert('Error al guardar tu adhesión');
        }
    };

    document.getElementById('submitAdhesion').onclick = handleSubmit;
}

function renderMapPins() {
    state.markers.forEach(m => state.map.removeLayer(m));
    state.markers = [];

    let filtered = state.claims.filter(c => c.status === 'approved');

    if (state.activeCategoryFilter !== 'all') {
        filtered = filtered.filter(c => c.category === state.activeCategoryFilter);
    }

    filtered.sort((a, b) => {
        const aPrio = calculatePriority(a.adhesions || 0);
        const bPrio = calculatePriority(b.adhesions || 0);
        const priorityOrder = { urgente: 0, prioritario: 1, normal: 2 };
        if (priorityOrder[aPrio] !== priorityOrder[bPrio]) {
            return priorityOrder[aPrio] - priorityOrder[bPrio];
        }
        return (b.adhesions || 0) - (a.adhesions || 0);
    });

    filtered.forEach(claim => {
        const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const prioritySvg = getPrioritySvg(claim.adhesions || 0);
        const icon = L.divIcon({
            html: `<div style="font-size:24px; filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));">${prioritySvg}</div>`,
            iconSize: [32, 32],
            className: ''
        });

        const marker = L.marker([claim.lat, claim.lng], { icon }).addTo(state.map);

        const locText = claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}`;
        const popupHTML = `
            <div class="custom-popup">
                ${claim.photo ? `<div class="popup-img-container"><img src="${claim.photo}" class="popup-mini-img"></div>` : ''}
                <div class="popup-title">${claim.title || claim.claimId}</div>
                <div class="popup-meta">${locText}</div>
                <div class="popup-time">${priorityLabel}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Ver detalles</button>
            </div>
        `;

        marker.bindPopup(popupHTML);
        state.markers.push(marker);
    });
}

function globalOpenDetailWindow(fbId) {
    const claim = state.claims.find(c => c._fbId === fbId);
    if (!claim) return;

    const priorityLabel = getPriorityLabel(claim.adhesions || 0);
    const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };

    let html = '';

    if (claim.photo) {
        html += `<div class="detail-card"><img src="${claim.photo}" class="detail-img"></div>`;
    }

    html += `
        <div class="detail-card">
            <div class="detail-label">ID</div>
            <div class="detail-value">${claim.claimId}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Título</div>
            <div class="detail-value">${claim.title || claim.claimId}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Categoría</div>
            <div class="detail-value">${cat.label}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Estado de Prioridad</div>
            <div class="detail-value"><span class="status-badge status-${calculatePriority(claim.adhesions || 0)}">${priorityLabel}</span></div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Ubicación Registrada</div>
            <div class="detail-value">${claim.lat.toFixed(4)}, ${claim.lng.toFixed(4)}</div>
        </div>
        ${claim.address ? `<div class="detail-card">
            <div class="detail-label">Referencia</div>
            <div class="detail-value">${claim.address}</div>
        </div>` : ''}
    `;

    if (claim.description) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Descripción</div>
                <div class="detail-value">${claim.description}</div>
            </div>
        `;
    }

    html += `
        <div class="adhesion-section">
            <div class="adhesion-count">
                <div class="adhesion-number">${claim.adhesions || 0}</div>
                <div class="adhesion-label">vecino${(claim.adhesions || 0) !== 1 ? 's' : ''} adhieren</div>
            </div>
            <button class="btn-adhesion" onclick="addAdhesion('${claim._fbId}')">Adherir</button>
        </div>
    `;

    const shareUrl = `${window.location.origin}${window.location.pathname}?claim=${claim.claimId}`;
    const shareText = `${claim.title}\nAyudanos adhiriendo a este reclamo ciudadano.\n${shareUrl}`;
    html += `
        <div class="detail-card">
            <div class="detail-label">Compartir</div>
            <div class="share-section">
                <button class="share-btn share-whatsapp" onclick="shareClaimOn('whatsapp', '${claim.title || claim.claimId}', '${shareUrl}')" title="WhatsApp">📱</button>
                <button class="share-btn share-facebook" onclick="shareClaimOn('facebook', '${claim.title || claim.claimId}', '${shareUrl}')" title="Facebook">f</button>
                <button class="share-btn share-instagram" onclick="shareClaimOn('instagram', '${claim.title || claim.claimId}', '${shareUrl}')" title="Instagram">📷</button>
                <button class="share-btn share-twitter" onclick="shareClaimOn('twitter', '${claim.title || claim.claimId}', '${shareUrl}')" title="X">𝕏</button>
            </div>
        </div>
    `;

    if (state.isAdmin) {
        html += `
            <div class="detail-actions">
                <button class="btn-action btn-approve" onclick="dispatchStatus('${claim._fbId}', 'approved')">✅ Aprobar</button>
                <button class="btn-action btn-reject" onclick="dispatchStatus('${claim._fbId}', 'rejected')">❌ Rechazar</button>
            </div>
        `;
        if (claim.status === 'approved') {
            html += `
                <div class="detail-actions">
                    <button class="btn-action" style="background:#8b5cf6; color:white;" onclick="dispatchStatus('${claim._fbId}', 'solved')">🛠️ Solucionado</button>
                    <button class="btn-action btn-reject" onclick="deleteClaimFromDatabase('${claim._fbId}')">🗑️ Borrar</button>
                </div>
            `;
        }
    }

    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailPanel').classList.add('visible');
    
    state.map.closePopup();
    document.getElementById('recentClaimsPopup').classList.add('hidden');
}

function shareClaimOn(platform, title, url) {
    const msg = `${title}. Ayudanos adhiriendo a este reclamo ciudadano.`;
    let shareUrl = '';

    switch(platform) {
        case 'whatsapp':
            shareUrl = `https://wa.me/?text=${encodeURIComponent(msg + ' ' + url)}`;
            break;
        case 'facebook':
            shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
            break;
        case 'instagram':
            alert('Copia el link y comparte en Instagram: ' + url);
            return;
        case 'twitter':
            shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(msg)}&url=${encodeURIComponent(url)}`;
            break;
    }

    if (shareUrl) window.open(shareUrl, '_blank');
}

function renderPublicClaimsList() {
    let approved = state.claims.filter(c => c.status === 'approved');
    
    if (state.activeCategoryFilter !== 'all') {
        approved = approved.filter(c => c.category === state.activeCategoryFilter);
    }

    approved.sort((a, b) => {
        const aPrio = calculatePriority(a.adhesions || 0);
        const bPrio = calculatePriority(b.adhesions || 0);
        const priorityOrder = { urgente: 0, prioritario: 1, normal: 2 };
        if (priorityOrder[aPrio] !== priorityOrder[bPrio]) {
            return priorityOrder[aPrio] - priorityOrder[bPrio];
        }
        return (b.adhesions || 0) - (a.adhesions || 0);
    });

    document.getElementById('claimCounter').textContent = approved.length;

    const html = approved.map((claim) => {
        const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const locText = claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}` || 'Ubicación registrada';
        return `
            <div class="claim-item" onclick="globalOpenDetailWindow('${claim._fbId}')">
                <div class="claim-item-header">
                    <span class="claim-item-id">${claim.claimId}</span>
                    <span class="claim-item-status">${priorityLabel}</span>
                </div>
                <div class="claim-item-name">${claim.title || claim.claimId}</div>
                <div class="claim-item-desc">${locText}...</div>
            </div>
        `;
    }).join('');
    document.getElementById('claimsList').innerHTML = html || '<div style="padding:16px; font-size:11px; color:#64748b; text-align:center; font-weight:600;">Sin reportes para esta sección.</div>';
}

async function dispatchStatus(fbId, newStatus) {
    const claim = state.claims.find(c => c._fbId === fbId);
    if (!claim) return;

    try {
        const { doc, updateDoc } = window.dbMethods;
        const docRef = doc(window.db, "reclamos", fbId);

        await updateDoc(docRef, { status: newStatus });
        claim.status = newStatus;
        
        renderPublicClaimsList();
        renderMapPins();
        if (state.isAdmin) syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');
        
        console.log(`✓ Estado actualizado: ${newStatus}`);
    } catch (error) {
        console.error("Error:", error);
        alert("No se pudo guardar el cambio.");
    }
}

async function deleteClaimFromDatabase(fbId) {
    const claim = state.claims.find(c => c._fbId === fbId);
    if (!claim) return;

    if (!confirm(`¿Eliminar reclamo ${claim.claimId}?`)) return;

    try {
        const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const { doc } = window.dbMethods;
        
        const docRef = doc(window.db, "reclamos", fbId);
        await deleteDoc(docRef);

        state.claims = state.claims.filter(c => c._fbId !== fbId);

        renderPublicClaimsList();
        renderMapPins();
        if (state.isAdmin) syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');
        
        console.log("✓ Reclamo eliminado");
    } catch (error) {
        console.error("Error:", error);
        alert("Error al eliminar.");
    }
}

function syncAdminDashboard() {
    document.getElementById('adminStatTotal').textContent = state.claims.length;
    document.getElementById('adminStatPending').textContent = state.claims.filter(c => c.status === 'pending').length;
    document.getElementById('adminStatApproved').textContent = state.claims.filter(c => c.status === 'approved').length;
    document.getElementById('adminStatSolved').textContent = state.claims.filter(c => c.status === 'solved').length;
    document.getElementById('adminStatRejected').textContent = state.claims.filter(c => c.status === 'rejected').length;
    
    const currentSection = document.querySelector('.admin-nav .nav-btn.active').dataset.section;
    renderAdminViewCards(currentSection);
}

function renderAdminViewCards(section) {
    const targets = state.claims.filter(c => c.status === section);
    const html = targets.map((claim) => {
        const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const createdDate = new Date(claim.createdAt).toLocaleDateString('es-AR');
        return `
            <div class="admin-card">
                <div class="admin-card-id">${claim.claimId}</div>
                <div class="admin-card-name">${claim.title || claim.claimId}</div>
                <div class="admin-card-text">"${claim.description?.substring(0, 60) || claim.address || 'Sin descripción'}..."</div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#f3f4f6; color:#374151;">Categoría: ${cat.label}</span>
                </div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#fef3c7; color:#92400e;">Prioridad: ${priorityLabel}</span>
                    <span class="admin-card-badge" style="background:#dbeafe; color:#1e40af;">${claim.adhesions || 0} adhesiones</span>
                </div>
                <div class="admin-card-meta">Creado: ${createdDate} | Autor: ${claim.name}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Inspeccionar</button>
            </div>
        `;
    }).join('');
    document.getElementById('adminList').innerHTML = html || '<p style="font-size:12px; color:#64748b; padding:10px; font-weight:600;">Sin registros en esta bandeja.</p>';
}

function initPoliticalCounter() {
    const startDate = new Date('2023-12-10T00:00:00');
    const targetDate = new Date('2027-12-10T00:00:00');
    
    const display = document.getElementById('daysCounter');
    const progressBar = document.getElementById('governmentProgressBar');

    const run = () => {
        const now = new Date();
        const totalDuration = targetDate - startDate;
        const timeElapsed = now - startDate;
        const timeRemaining = targetDate - now;
        
        const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));
        let percentComplete = (timeElapsed / totalDuration) * 100;
        percentComplete = Math.min(100, Math.max(0, percentComplete));

        if (progressBar) progressBar.style.width = `${percentComplete.toFixed(1)}%`;
        if (display) display.textContent = `Transcurrido: ${percentComplete.toFixed(1)}% (${daysRemaining} días restantes)`;
    };

    run();
    setInterval(run, 60000);

    const block = document.querySelector('.political-counter');
    if (block) {
        block.style.cursor = 'pointer';
        block.addEventListener('dblclick', () => {
            const intento = prompt('🔑 Ingrese clave de administración:');
            if (intento === ADMIN_CODE) {
                state.isAdmin = true;
                document.getElementById('adminSessionBar').style.display = 'flex';
                syncAdminDashboard();
                renderMapPins();
                alert('✅ Modo Auditor Activado');
            } else if (intento !== null) {
                alert('❌ Clave incorrecta');
            }
        });
    }
}

async function loadFirebaseData() {
    try {
        const { collection, getDocs } = window.dbMethods;
        const querySnapshot = await getDocs(collection(window.db, "reclamos"));
        
        const cargados = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            cargados.push({
                _fbId: doc.id,
                ...data,
                adhesions: data.adhesions || 0
            });
        });
        
        state.claims = cargados;
        console.log("✅ Datos cargados:", state.claims.length);
    } catch (error) {
        console.error("❌ Error Firebase:", error);
        state.claims = [];
    }
}