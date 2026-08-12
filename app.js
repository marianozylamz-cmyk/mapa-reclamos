// ==================== PAGE LOADER INIT ====================
const initPageLoader = () => {
    const MIN_SHOW_MS = 800;
    const MAX_WAIT_MS = 3500;
    
    const loader = document.getElementById('mp-page-loader');
    const body = document.body;
    
    if (!loader) return;
    
    // Agregar clase de "cargando" al body
    body.classList.add('mp-loading');
    
    // Tiempo mínimo de espera
    let minTimeReached = false;
    setTimeout(() => {
        minTimeReached = true;
        // Si ya está listo, remover inmediatamente
        if (window.mpLoaderReady) {
            hidePageLoader();
        }
    }, MIN_SHOW_MS);
    
    // Timeout máximo de respaldo (3.5 seg)
    window.mpLoaderTimeout = setTimeout(() => {
        hidePageLoader();
    }, MAX_WAIT_MS);
    
    // Función para ocultar el loader
    window.hidePageLoader = () => {
        if (!loader) return;
        
        clearTimeout(window.mpLoaderTimeout);
        
        loader.classList.add('mp-fade-out');
        body.classList.remove('mp-loading');
        
        // Eliminar del DOM después de la animación
        setTimeout(() => {
            if (loader.parentNode) {
                loader.parentNode.removeChild(loader);
            }
            window.mpLoaderReady = true;
        }, 400);
    };
    
    // Marcar como "ready" cuando el loader esté listo para ocultarse
    window.mpLoaderReady = false;
};

// Inicializar el loader
initPageLoader();

const OLAVARRIA_LAT = -36.8927;
const OLAVARRIA_LNG = -60.3225;
const OLAVARRIA_BOUNDS = {
    minLat: -36.99,
    maxLat: -36.75,
    minLng: -60.52,
    maxLng: -60.05
};

const CATEGORIES = {
    plazas: { label: 'Parques/Paseos/Plazas' },
    salud: { label: 'Salud' },
    alumbrado: { label: 'Alumbrado' },
    calle: { label: 'Bache/Calle/Camino' },
    basura: { label: 'Basura' },
    otro: { label: 'Otros' }
};

const state = {
    claims: [],               // datos públicos (reclamos_publicos) - aprobados/solucionados
    adminClaims: [],          // datos completos (reclamos) - solo si sos admin
    mySessionPendingClaims: [], // reclamos pendientes cargados por VOS en esta sesión (en memoria, se pierde al recargar)
    map: null,
    clusterGroup: null,       // agrupa los pines aprobados
    markers: [],              // pines pendientes en gris (sueltos, sin clusterizar)
    isAdmin: false,
    selectedCategory: null,
    currentLocation: null,
    currentPhoto: null,
    activeCategoryFilter: 'all',
    mapClickLocation: null
};

document.addEventListener('DOMContentLoaded', async () => {
    initAuthListener();
    await loadPublicClaims();
    initLeafletMap();
    setupApplicationEvents();
    renderPublicClaimsList();
    initPoliticalCounter();
    handleDeepLinking();
    
    // ← AGREGAR ESTA LÍNEA: Ocultar loader después de que todo esté listo
    if (typeof hidePageLoader === 'function') {
        setTimeout(() => hidePageLoader(), 200);
    }
});

// ---------------------------------------------------------------------------
// AUTENTICACIÓN ADMIN
// ---------------------------------------------------------------------------

function initAuthListener() {
    const { onAuthStateChanged } = window.authMethods;

    onAuthStateChanged(window.auth, async (user) => {
        if (!user) {
            state.isAdmin = false;
            state.adminClaims = [];
            document.getElementById('adminSessionBar').style.display = 'none';
            document.getElementById('adminPanel').classList.add('hidden');
            if (state.map) renderMapPins();
            return;
        }

        try {
            const tokenResult = await user.getIdTokenResult();
            if (tokenResult.claims.admin === true) {
                state.isAdmin = true;
                document.getElementById('adminSessionBar').style.display = 'flex';
                await loadAdminClaims();
                syncAdminDashboard();
                renderMapPins();
                renderPublicClaimsList();
            } else {
                state.isAdmin = false;
                document.getElementById('adminSessionBar').style.display = 'none';
            }
        } catch (error) {
            console.error('Error verificando sesión admin:', error);
            state.isAdmin = false;
        }
    });
}

async function handleAdminLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const errorEl = document.getElementById('adminLoginError');
    const btn = document.getElementById('adminLoginBtn');

    errorEl.style.display = 'none';

    if (!email || !password) {
        errorEl.textContent = 'Completá email y contraseña';
        errorEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Ingresando...';

    try {
        const { signInWithEmailAndPassword } = window.authMethods;
        await signInWithEmailAndPassword(window.auth, email, password);
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminEmail').value = '';
        document.getElementById('adminPassword').value = '';
    } catch (error) {
        console.error('Error de login:', error);
        errorEl.textContent = 'Email o contraseña incorrectos';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Ingresar';
    }
}

async function handleAdminLogout() {
    const { signOut } = window.authMethods;
    try {
        await signOut(window.auth);
    } catch (error) {
        console.error('Error al salir:', error);
    }
    window.location.href = window.location.pathname;
}

// ---------------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function findClaimById(fbId) {
    if (state.isAdmin) {
        const fromAdmin = state.adminClaims.find(c => c._fbId === fbId);
        if (fromAdmin) return fromAdmin;
    }
    const fromSession = state.mySessionPendingClaims.find(c => c._fbId === fbId);
    if (fromSession) return fromSession;
    return state.claims.find(c => c._fbId === fbId);
}

function handleDeepLinking() {
    const params = new URLSearchParams(window.location.search);
    const claimId = params.get('claim');

    if (claimId) {
        const claim = state.claims.find(c => c.claimId === claimId);
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

    // Los reclamos aprobados van agrupados (clustering) para que no se amontonen
    // en el mapa cuando hay muchos cerca. Ver leaflet.markercluster en index.html.
   state.clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 5,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function(cluster) {
        const childCount = cluster.getChildCount();
        const adhesions = Math.max(...cluster.getAllChildMarkers().map(m => {
            const data = m.options.claimData;
            return data ? (data.adhesions || 0) : 0;
        }));
        const priority = adhesions >= 20 ? 'urgente' : (adhesions >= 10 ? 'prioritario' : 'normal');
        const coneImg = priority === 'urgente' ? 'cono-rojo.png' : (priority === 'prioritario' ? 'cono-naranja.png' : 'cono-amarillo.png');
        
        return L.divIcon({
            html: `
                <div style="position: relative; width: 42px; height: 42px;">
                    <img src="${coneImg}" style="width: 42px; height: 42px; filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));">
                    <div style="position: absolute; bottom: -8px; right: -8px; background: #1e293b; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${childCount}</div>
                </div>
            `,
            iconSize: [42, 42],
            className: ''
        });
    }
});
    state.map.addLayer(state.clusterGroup);

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
    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    
    state.mapClickLocation = { lat, lng };
    
    // Agregar marcador visual temporal en el mapa
    if (window.mapClickMarker) {
        state.map.removeLayer(window.mapClickMarker);
    }
    
    const icon = L.divIcon({
        html: `<div style="width:20px; height:20px; border-radius:50%; background:#10b981; border:3px solid white; box-shadow:0 0 8px rgba(16,185,129,0.6);"></div>`,
        iconSize: [26, 26],
        className: ''
    });
    
    window.mapClickMarker = L.marker([lat, lng], { icon }).addTo(state.map);
    
    overlay.classList.remove('hidden');
    banner.classList.remove('hidden');

    const confirmAction = () => {
        state.currentLocation = { lat, lng };
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        if (window.mapClickMarker) {
            state.map.removeLayer(window.mapClickMarker);
            window.mapClickMarker = null;
        }
        document.getElementById('claimModal').classList.remove('hidden');
        showLocationDisplay();
    };

    document.getElementById('cancelMapClickBanner').onclick = () => {
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        if (window.mapClickMarker) {
            state.map.removeLayer(window.mapClickMarker);
            window.mapClickMarker = null;
        }
        document.getElementById('claimModal').classList.remove('hidden');
        state.mapClickLocation = null;
    };

    state.map.once('click', (e) => {
        const newLat = e.latlng.lat;
        const newLng = e.latlng.lng;

        if (!isWithinOlavarria(newLat, newLng)) {
            alert('⚠️ Solo puedes crear reclamos dentro del partido de Olavarría');
            return;
        }

        state.mapClickLocation = { lat: newLat, lng: newLng };
        confirmAction();
    });
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
    document.getElementById('successCloseBtn').addEventListener('click', closeClaimModal);
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
    document.getElementById('exitSessionBtn').addEventListener('click', handleAdminLogout);

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

    document.getElementById('adminLoginBtn').addEventListener('click', handleAdminLogin);
    document.getElementById('cancelAdminLogin').addEventListener('click', () => {
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminLoginError').style.display = 'none';
    });
    document.getElementById('closeAdminLogin').addEventListener('click', () => {
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminLoginError').style.display = 'none';
    });
    document.getElementById('adminPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAdminLogin();
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

    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    
    overlay.classList.remove('hidden');
    banner.classList.remove('hidden');

    document.getElementById('cancelMapClickBanner').onclick = () => {
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        modal.classList.remove('hidden');
        state.mapClickLocation = null;
    };
}

function closeClaimModal() {
    document.getElementById('claimModal').classList.add('hidden');
    const indicator = document.getElementById('mapClickIndicator');
    if (indicator) indicator.remove();
    state.currentLocation = null;
    state.selectedCategory = null;
    state.currentPhoto = null;
    document.getElementById('locationDisplay').style.display = 'none';
    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    overlay.classList.add('hidden');
    banner.classList.add('hidden');
    if (window.mapClickMarker) {
        state.map.removeLayer(window.mapClickMarker);
        window.mapClickMarker = null;
    }
    resetFormState(false);
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

    // Volvemos a mostrar el formulario (por si veníamos de la pantalla de éxito)
    document.getElementById('claimFormBody').style.display = '';
    document.getElementById('formSuccessView').style.display = 'none';
    document.getElementById('formMessage').style.display = 'none';
    document.getElementById('submitBtn').style.display = '';
    document.getElementById('closeModalBtn').style.display = '';
    document.getElementById('successCloseBtn').style.display = 'none';

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

// ---------------------------------------------------------------------------
// FOTOS — aceptamos cualquier tamaño real de foto de celular. La comprimimos
// nosotros en el navegador (canvas) antes de guardarla, así siempre entra en
// el límite de 1MB por documento que tiene Firestore. Nunca bloqueamos al
// usuario por el peso del archivo original.
// ---------------------------------------------------------------------------

function processPhotoFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validar que sea imagen, no video
    if (!file.type.startsWith('image/')) {
        flashErrorMessage('Solo se aceptan imágenes. Por favor, sube una foto.');
        return;
    }

    // Validar tamaño máximo 5MB
    if (file.size > 5 * 1024 * 1024) {
        flashErrorMessage('La imagen pesa demasiado para subirla desde tu dispositivo');
        return;
    }

    const dropIcon = document.getElementById('photoDropIcon');
    const dropLabel = document.getElementById('photoDropLabel');
    const originalIcon = dropIcon.textContent;
    const originalLabel = dropLabel.textContent;

    dropIcon.textContent = '⏳';
    dropLabel.textContent = 'Optimizando imagen...';

    compressImage(file)
        .then((dataUrl) => {
            state.currentPhoto = dataUrl;
            document.getElementById('photoImg').src = state.currentPhoto;
            dropIcon.textContent = originalIcon;
            dropLabel.textContent = originalLabel;
            document.getElementById('photoDropZone').style.display = 'none';
            document.getElementById('photoPreview').style.display = 'block';
        })
        .catch((error) => {
            console.error('Error procesando la imagen:', error);
            dropIcon.textContent = originalIcon;
            dropLabel.textContent = originalLabel;
            flashErrorMessage('No se pudo procesar esa imagen. Probá con otra foto.');
        });
}

function compressImage(file, maxWidth = 1600) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxWidth) {
                    height = Math.round(height * (maxWidth / width));
                    width = maxWidth;
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                let quality = 0.75;
                let dataUrl = canvas.toDataURL('image/jpeg', quality);

                // Firestore tiene un límite de 1MB por documento. Bajamos calidad
                // hasta que la foto entre cómoda, sin bloquear nunca al usuario
                // por el tamaño del archivo original (puede ser 12MB de un iPhone,
                // no importa: acá la reducimos igual).
                while (dataUrl.length > 700 * 1024 && quality > 0.3) {
                    quality -= 0.1;
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                }

                resolve(dataUrl);
            };
            img.onerror = () => reject(new Error('No se pudo leer la imagen'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
    });
}

function clearPhotoEvidencia() {
    state.currentPhoto = null;
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoDropZone').style.display = 'block';
    document.getElementById('claimPhoto').value = '';
}

// ---------------------------------------------------------------------------
// CREAR RECLAMO
// ---------------------------------------------------------------------------

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
    // Teléfono es opcional ahora
    if (phone && !phone.startsWith('2284')) return flashErrorMessage('Si completas teléfono, debe empezar con 2284 (Olavarría)');

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

    const btn = document.getElementById('submitBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
        const { collection, addDoc } = window.dbMethods;
        const docRef = await addDoc(collection(window.db, "reclamos"), claimData);
        claimData._fbId = docRef.id;

        if (state.isAdmin) {
            state.adminClaims.push(claimData);
            syncAdminDashboard();
        } else {
            // Se guarda SOLO en memoria de esta pestaña. Si la persona recarga
            // o vuelve a entrar más tarde, este pin gris ya no va a aparecer
            // (es intencional: es un "quedate tranquilo", no un tracking).
            state.mySessionPendingClaims.push(claimData);
        }

        renderMapPins();

        // Pantalla de éxito clara en vez de un cartelito chico que desaparece solo.
        document.getElementById('claimFormBody').style.display = 'none';
        document.getElementById('formSuccessView').style.display = 'block';
        document.getElementById('submitBtn').style.display = 'none';
        document.getElementById('closeModalBtn').style.display = 'none';
        document.getElementById('successCloseBtn').style.display = 'inline-block';

        state.currentLocation = null;
        state.selectedCategory = null;
        state.currentPhoto = null;
    } catch (error) {
        console.error('Error al guardar:', error);
        const msg = navigator.onLine
            ? 'Error al guardar. Intenta nuevamente.'
            : 'Sin conexión a internet. Revisá tu conexión e intenta de nuevo.';
        flashErrorMessage(msg);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar Reporte';
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
    if (adhesions >= 20) {
        return '<img src="cono-rojo.png" class="priority-icon" alt="Urgente">';
    }
    if (adhesions >= 10) {
        return '<img src="cono-naranja.png" class="priority-icon" alt="Prioritario">';
    }
    return '<img src="cono-amarillo.png" class="priority-icon" alt="Normal">';
}

// ---------------------------------------------------------------------------
// ADHESIÓN
// ---------------------------------------------------------------------------

async function addAdhesion(claimId) {
    document.getElementById('detailPanel').classList.remove('visible');

    const modal = document.getElementById('adhesionModal');
    modal.classList.remove('hidden');

    const submitBtn = document.getElementById('submitAdhesion');

    const handleSubmit = async () => {
        const name = document.getElementById('adhesionName').value.trim();
        if (!name) {
            alert('Ingresa tu nombre para adherir');
            return;
        }

        const claim = state.claims.find(c => c._fbId === claimId);
        if (!claim) return;

        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';

        try {
            const newCount = (claim.adhesions || 0) + 1;
            const { doc, updateDoc } = window.dbMethods;
            const docRef = doc(window.db, "reclamos_publicos", claimId);
            await updateDoc(docRef, { adhesions: newCount });
            claim.adhesions = newCount;

            document.getElementById('adhesionName').value = '';
            modal.classList.add('hidden');

            renderPublicClaimsList();
            renderMapPins();
            globalOpenDetailWindow(claimId);

            alert('✅ ¡Gracias por tu adhesión!');
        } catch (error) {
            console.error('Error al adherir:', error);
            alert('Error al guardar tu adhesión');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Adherir';
        }
    };

    submitBtn.onclick = handleSubmit;
}

// ---------------------------------------------------------------------------
// MAPA — aprobados agrupados (clustering) + pendientes en gris
// ---------------------------------------------------------------------------

function renderMapPins() {
    if (!state.map || !state.clusterGroup) return;

    state.clusterGroup.clearLayers();
    state.markers.forEach(m => state.map.removeLayer(m));
    state.markers = [];

    // --- Aprobados (clusterizados) ---
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
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const prioritySvg = getPrioritySvg(claim.adhesions || 0);
        const icon = L.divIcon({
            html: `<div style="font-size:24px; filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));">${prioritySvg}</div>`,
            iconSize: [32, 32],
            className: ''
        });

const marker = L.marker([claim.lat, claim.lng], { icon, claimData: claim });

        const locText = escapeHtml(claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}`);
        const popupHTML = `
            <div class="custom-popup">
                ${claim.photo ? `<div class="popup-img-container"><img src="${claim.photo}" class="popup-mini-img"></div>` : ''}
                <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="popup-meta">${locText}</div>
                <div class="popup-time">${priorityLabel}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Ver detalles</button>
            </div>
        `;

        marker.bindPopup(popupHTML);
        state.clusterGroup.addLayer(marker);
    });

    // --- Pendientes en gris (sin clusterizar, son pocos) ---
    // Admin: ve TODOS los pendientes reales (vienen de Firestore, persistentes).
    // Vecino sin sesión admin: ve SOLO lo que él mismo cargó en esta pestaña.
    let pendingToShow = state.isAdmin
        ? state.adminClaims.filter(c => c.status === 'pending')
        : state.mySessionPendingClaims;

    if (state.activeCategoryFilter !== 'all') {
        pendingToShow = pendingToShow.filter(c => c.category === state.activeCategoryFilter);
    }

    pendingToShow.forEach(claim => {
        const icon = L.divIcon({
            html: `<div style="width:18px; height:18px; border-radius:50%; background:#94a3b8; border:2px solid #fff; box-shadow:0 0 4px rgba(0,0,0,0.4);"></div>`,
            iconSize: [22, 22],
            className: ''
        });

        const marker = L.marker([claim.lat, claim.lng], { icon, opacity: 0.85 }).addTo(state.map);

        const popupHTML = state.isAdmin
            ? `
                <div class="custom-popup">
                    <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                    <div class="popup-meta">⏳ Pendiente de revisión</div>
                    <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Inspeccionar</button>
                </div>
            `
            : `
                <div class="custom-popup">
                    <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                    <div class="popup-meta">⏳ Tu reclamo — pendiente de revisión</div>
                </div>
            `;

        marker.bindPopup(popupHTML);
        state.markers.push(marker);
    });
}

function globalOpenDetailWindow(fbId) {
    const claim = findClaimById(fbId);
    if (!claim) return;

    const priorityLabel = getPriorityLabel(claim.adhesions || 0);
    const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };

   let html = '';

    if (claim.photo) {
        html += `<div class="detail-card"><img src="${claim.photo}" class="detail-img"></div>`;
    }

    // ID solo visible para admin
    if (state.isAdmin) {
        html += `
            <div class="detail-card">
                <div class="detail-label">ID</div>
                <div class="detail-value">${escapeHtml(claim.claimId)}</div>
            </div>
        `;
    }

    html += `
        <div class="detail-card">
            <div class="detail-label">Título</div>
            <div class="detail-value">${escapeHtml(claim.title || claim.claimId)}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Categoría</div>
            <div class="detail-value">${escapeHtml(cat.label)}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Estado de Prioridad</div>
            <div class="detail-value"><span class="status-badge status-${calculatePriority(claim.adhesions || 0)}">${priorityLabel}</span></div>
        </div>
    `;

    // Coordenadas solo para admin
    if (state.isAdmin) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Ubicación Registrada (GPS)</div>
                <div class="detail-value">${claim.lat.toFixed(4)}, ${claim.lng.toFixed(4)}</div>
            </div>
        `;
    }

    if (claim.description) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Descripción</div>
                <div class="detail-value">${escapeHtml(claim.description)}</div>
            </div>
        `;
    }

    // Dirección siempre visible (si existe)
    if (claim.address) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Dirección / Referencia</div>
                <div class="detail-value">${escapeHtml(claim.address)}</div>
            </div>
        `;
    }

    if (claim.description) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Descripción</div>
                <div class="detail-value">${escapeHtml(claim.description)}</div>
            </div>
        `;
    }

    if (claim.status === 'approved' || claim.status === 'solved') {
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
        const shareTitle = escapeHtml(claim.title || claim.claimId);
        html += `
            <div class="detail-card">
                <div class="detail-label">Compartir</div>
                <div class="share-section">
                    <button class="share-btn share-whatsapp" onclick="shareClaimOn('whatsapp', '${shareTitle}', '${shareUrl}')" title="WhatsApp">📱</button>
                    <button class="share-btn share-facebook" onclick="shareClaimOn('facebook', '${shareTitle}', '${shareUrl}')" title="Facebook">f</button>
                    <button class="share-btn share-instagram" onclick="shareClaimOn('instagram', '${shareTitle}', '${shareUrl}')" title="Instagram">📷</button>
                    <button class="share-btn share-twitter" onclick="shareClaimOn('twitter', '${shareTitle}', '${shareUrl}')" title="X">𝕏</button>
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="detail-card" style="background:#f1f5f9;">
                <div class="detail-label">Estado</div>
                <div class="detail-value">⏳ Pendiente de revisión por un administrador</div>
            </div>
        `;
    }

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
// Centrar mapa en el reclamo y resaltar
    if (state.map) {
        state.map.setView([claim.lat, claim.lng], 16);
        
        // Opcional: dimmar otros marcadores (efecto sutil)
        document.querySelectorAll('.leaflet-marker-icon').forEach(marker => {
            marker.style.opacity = '0.3';
        });
        
        // Encontrar y resaltar el marcador específico del reclamo actual
        setTimeout(() => {
            state.clusterGroup.eachLayer((layer) => {
                if (layer.options && layer.options.claimData && layer.options.claimData._fbId === fbId) {
                    layer.setOpacity(1);
                }
            });
            state.markers.forEach(marker => {
                if (marker.options && marker.options.claimData && marker.options.claimData._fbId === fbId) {
                    marker.setOpacity(1);
                }
            });
        }, 100);
    }
    // Admin puede editar si está en pending
    let editingClaimId = null;
    if (state.isAdmin && claim.status === 'pending') {
        html += `
            <div style="text-align:center; padding:8px;">
                <button id="toggleEditModeBtn" style="background:#8b5cf6; color:white; border:none; padding:6px 12px; border-radius:6px; font-weight:600; font-size:11px; cursor:pointer;">✏️ Editar antes de procesar</button>
            </div>
        `;
    }
    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailPanel').classList.add('visible');
    // Setup para el botón de edición (solo si es admin y está pending)
    if (state.isAdmin && claim.status === 'pending') {
        const toggleEditBtn = document.getElementById('toggleEditModeBtn');
        const editForm = document.getElementById('detailEditForm');
        const bodyDiv = document.getElementById('detailBody');
        
        document.getElementById('editClaimDescription').value = claim.description || '';
        document.getElementById('editClaimAddress').value = claim.address || '';
        document.getElementById('editClaimCategory').value = claim.category || 'otro';
        
        toggleEditBtn.addEventListener('click', () => {
            const isHidden = editForm.style.display === 'none';
            editForm.style.display = isHidden ? 'block' : 'none';
            bodyDiv.style.display = isHidden ? 'none' : 'block';
            toggleEditBtn.textContent = isHidden ? '✕ Cerrar edición' : '✏️ Editar antes de procesar';
        });
        
        document.getElementById('saveEditBtn').addEventListener('click', async () => {
            const newDesc = document.getElementById('editClaimDescription').value.trim();
            const newAddr = document.getElementById('editClaimAddress').value.trim();
            const newCat = document.getElementById('editClaimCategory').value;
            
            const btn = document.getElementById('saveEditBtn');
            btn.disabled = true;
            btn.textContent = 'Guardando...';
            
            try {
                const { doc, updateDoc } = window.dbMethods;
                await updateDoc(doc(window.db, "reclamos", fbId), {
                    description: newDesc,
                    address: newAddr,
                    category: newCat
                });
                
                claim.description = newDesc;
                claim.address = newAddr;
                claim.category = newCat;
                
                editForm.style.display = 'none';
                bodyDiv.style.display = 'block';
                toggleEditBtn.textContent = '✏️ Editar antes de procesar';
                
                globalOpenDetailWindow(fbId);
                alert('✅ Reclamo actualizado');
            } catch (error) {
                console.error('Error al guardar edición:', error);
                alert('Error al guardar los cambios');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Guardar';
            }
        });
        
        document.getElementById('cancelEditBtn').addEventListener('click', () => {
            editForm.style.display = 'none';
            bodyDiv.style.display = 'block';
            toggleEditBtn.textContent = '✏️ Editar antes de procesar';
        });
    }

    state.map.closePopup();
    document.getElementById('recentClaimsPopup').classList.add('hidden');
}

function shareClaimOn(platform, title, url) {
    const msg = `${title}. Ayudanos adhiriendo a este reclamo ciudadano.`;
    let shareUrl = '';

    switch (platform) {
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
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const locText = escapeHtml(claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}` || 'Ubicación registrada');
        return `
            <div class="claim-item" onclick="globalOpenDetailWindow('${claim._fbId}')">
                <div class="claim-item-header">
                    <span class="claim-item-id">${escapeHtml(claim.claimId)}</span>
                    <span class="claim-item-status">${priorityLabel}</span>
                </div>
                <div class="claim-item-name">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="claim-item-desc">${locText}...</div>
            </div>
        `;
    }).join('');
    document.getElementById('claimsList').innerHTML = html || '<div style="padding:16px; font-size:11px; color:#64748b; text-align:center; font-weight:600;">Sin reportes para esta sección.</div>';
}

// ---------------------------------------------------------------------------
// ACCIONES ADMIN
// ---------------------------------------------------------------------------

async function dispatchStatus(fbId, newStatus) {
    const claim = state.adminClaims.find(c => c._fbId === fbId);
    if (!claim) return;

    try {
        const { doc, updateDoc, setDoc, deleteDoc } = window.dbMethods;

        await updateDoc(doc(window.db, "reclamos", fbId), { status: newStatus });
        claim.status = newStatus;

        const publicRef = doc(window.db, "reclamos_publicos", fbId);

        if (newStatus === 'approved' || newStatus === 'solved') {
            await setDoc(publicRef, {
                claimId: claim.claimId,
                title: claim.title,
                category: claim.category,
                address: claim.address || '',
                description: claim.description || '',
                lat: claim.lat,
                lng: claim.lng,
                photo: claim.photo || null,
                status: newStatus,
                adhesions: claim.adhesions || 0,
                createdAt: claim.createdAt
            });
        } else {
            try { await deleteDoc(publicRef); } catch (e) { /* puede no existir todavía, ok */ }
        }

        await loadPublicClaims();
        renderPublicClaimsList();
        renderMapPins();
        syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');

        console.log(`✓ Estado actualizado: ${newStatus}`);
    } catch (error) {
        console.error("Error:", error);
        alert("No se pudo guardar el cambio.");
    }
}

async function deleteClaimFromDatabase(fbId) {
    const claim = state.adminClaims.find(c => c._fbId === fbId);
    if (!claim) return;

    if (!confirm(`¿Eliminar reclamo ${claim.claimId}?`)) return;

    try {
        const { doc, deleteDoc } = window.dbMethods;

        await deleteDoc(doc(window.db, "reclamos", fbId));
        try { await deleteDoc(doc(window.db, "reclamos_publicos", fbId)); } catch (e) { /* puede no existir, ok */ }

        state.adminClaims = state.adminClaims.filter(c => c._fbId !== fbId);
        state.claims = state.claims.filter(c => c._fbId !== fbId);

        renderPublicClaimsList();
        renderMapPins();
        syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');

        console.log("✓ Reclamo eliminado");
    } catch (error) {
        console.error("Error:", error);
        alert("Error al eliminar.");
    }
}

function syncAdminDashboard() {
    document.getElementById('adminStatTotal').textContent = state.adminClaims.length;
    document.getElementById('adminStatPending').textContent = state.adminClaims.filter(c => c.status === 'pending').length;
    document.getElementById('adminStatApproved').textContent = state.adminClaims.filter(c => c.status === 'approved').length;
    document.getElementById('adminStatSolved').textContent = state.adminClaims.filter(c => c.status === 'solved').length;
    document.getElementById('adminStatRejected').textContent = state.adminClaims.filter(c => c.status === 'rejected').length;

    const currentSection = document.querySelector('.admin-nav .nav-btn.active').dataset.section;
    renderAdminViewCards(currentSection);
}

function renderAdminViewCards(section) {
    const targets = state.adminClaims.filter(c => c.status === section);
    const html = targets.map((claim) => {
        const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const createdDate = new Date(claim.createdAt).toLocaleDateString('es-AR');
        return `
            <div class="admin-card">
                <div class="admin-card-id">${escapeHtml(claim.claimId)}</div>
                <div class="admin-card-name">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="admin-card-text">"${escapeHtml((claim.description || claim.address || 'Sin descripción').substring(0, 60))}..."</div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#f3f4f6; color:#374151;">Categoría: ${escapeHtml(cat.label)}</span>
                </div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#fef3c7; color:#92400e;">Prioridad: ${priorityLabel}</span>
                    <span class="admin-card-badge" style="background:#dbeafe; color:#1e40af;">${claim.adhesions || 0} adhesiones</span>
                </div>
                <div class="admin-card-meta">Creado: ${createdDate} | Autor: ${escapeHtml(claim.name)}</div>
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

        if (progressBar) {
            progressBar.style.width = `${percentComplete.toFixed(1)}%`;
            progressBar.innerHTML = `<span style="color:white; font-weight:700; font-size:12px; text-shadow:0 1px 2px rgba(0,0,0,0.3);">${percentComplete.toFixed(1)}%</span>`;
        }
        if (display) display.textContent = `${daysRemaining} días para que arreglen esto`;
    };

    run(); // ← Ejecutar una vez al cargar
    setInterval(run, 60000); // ← Actualizar cada minuto

    const block = document.querySelector('.political-counter');
    if (block) {
        block.style.cursor = 'pointer';
        block.addEventListener('dblclick', () => {
            document.getElementById('adminLoginModal').classList.remove('hidden');
        });
    }
}

// ---------------------------------------------------------------------------
// CARGA DE DATOS
// ---------------------------------------------------------------------------

async function loadPublicClaims() {
    try {
        const { collection, getDocs } = window.dbMethods;
        const querySnapshot = await getDocs(collection(window.db, "reclamos_publicos"));

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
        console.log("✅ Reclamos públicos cargados:", state.claims.length);
    } catch (error) {
        console.error("❌ Error cargando reclamos públicos:", error);
        state.claims = [];
    }
}

async function loadAdminClaims() {
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

        state.adminClaims = cargados;
        console.log("✅ Panel admin cargado:", state.adminClaims.length);
    } catch (error) {
        console.error("❌ Error cargando panel admin:", error);
        state.adminClaims = [];
    }
}