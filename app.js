const OLAVARRIA_LAT = -36.8927;
const OLAVARRIA_LNG = -60.3225;
const STORAGE_KEY = 'reclamosData';
const ADMIN_CODE = 'varilla';

const CATEGORIES = {
    vereda: { icon: '🧱', label: 'Vereda rota' },
    bache: { icon: '🕳️', label: 'Bache' },
    arbol: { icon: '🌳', label: 'Árbol caído' },
    luz: { icon: '💡', label: 'Alumbrado' },
    basura: { icon: '🚮', label: 'Basura masiva' },
    otro: { icon: '🚧', label: 'Otros' }
};

const URGENCY_COLORS = {
    alta: { color: '#ef4444', label: 'Alta - Peligro Inminente' },
    normal: { color: '#f97316', label: 'Normal - Incidente Estándar' }
};

const state = {
    claims: [],
    map: null,
    markers: [],
    isAdmin: false,
    currentStep: 1,
    maxSteps: 6,
    selectedCategory: null,
    selectedUrgency: null,
    currentLocation: null,
    currentPhoto: null,
    activeCategoryFilter: 'all'
};

document.addEventListener('DOMContentLoaded', () => {
    checkAdminAccess();
    loadStorageData();
    initLeafletMap();
    setupApplicationEvents();
    renderPublicClaimsList();
    initPoliticalCounter();
});

function checkAdminAccess() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') === ADMIN_CODE) {
        state.isAdmin = true;
        document.getElementById('adminSessionBar').style.display = 'flex';
    }
}

function initLeafletMap() {
    state.map = L.map('map', { zoomControl: false }).setView([OLAVARRIA_LAT, OLAVARRIA_LNG], 14);
    L.control.zoom({ position: 'bottomleft' }).addTo(state.map);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(state.map);

    renderMapPins();
}

function setupApplicationEvents() {
    // Modal Apertura/Cierre
    document.getElementById('newClaimBtn').addEventListener('click', () => {
        document.getElementById('claimModal').classList.remove('hidden');
        resetFormState();
    });
    document.getElementById('closeModal').addEventListener('click', () => {
        document.getElementById('claimModal').classList.add('hidden');
    });
    document.getElementById('closeDetail').addEventListener('click', () => {
        document.getElementById('detailPanel').classList.remove('visible');
    });

    // Toggle de la burbuja flotante de Recientes
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

    // Control del Filtro Flotante de Categorías en el Mapa
    document.getElementById('categoryFilterBar').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        state.activeCategoryFilter = btn.dataset.cat;
        renderMapPins();
        renderPublicClaimsList();
    });

    // Flujo Navegación Modal Paso a Paso
    document.getElementById('nextBtn').addEventListener('click', handleNextStep);
    document.getElementById('prevBtn').addEventListener('click', handlePrevStep);
    document.getElementById('submitBtn').addEventListener('click', executeSubmitForm);

    // Selección Reactiva de Categoría (Paso 2)
    const categoriesOptions = document.querySelectorAll('#categoryGrid .category-option');
    categoriesOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            categoriesOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            state.selectedCategory = opt.getAttribute('data-value');
        });
    });

    // Selección Reactiva de Urgencia (Paso 3)
    const urgencyOptions = document.querySelectorAll('#urgencyGrid .category-option');
    urgencyOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            urgencyOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            state.selectedUrgency = opt.getAttribute('data-value');
        });
    });

    // Captura GPS
    document.getElementById('useGPS').addEventListener('click', triggerGPSCapture);

    // Tratamiento de Fotos Evidencia
    document.getElementById('photoDropZone').addEventListener('click', () => document.getElementById('claimPhoto').click());
    document.getElementById('claimPhoto').addEventListener('change', processPhotoFile);
    document.getElementById('removePhoto').addEventListener('click', clearPhotoEvidencia);

    // Enlaces de Sesión Administrativa Segura
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

    // Filtros del Sidebar del Dashboard Admin
    document.querySelectorAll('.admin-nav .nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.admin-nav .nav-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderAdminViewCards(e.target.dataset.section);
        });
    });
}

function handleNextStep() {
    if (validateStepData()) {
        state.currentStep++;
        refreshFormWizardSteps();
    }
}

function handlePrevStep() {
    state.currentStep--;
    refreshFormWizardSteps();
}

function refreshFormWizardSteps() {
    document.querySelectorAll('.form-step').forEach(step => step.classList.remove('active'));
    document.querySelector(`[data-step="${state.currentStep}"]`).classList.add('active');

    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const submitBtn = document.getElementById('submitBtn');

    prevBtn.style.display = state.currentStep > 1 ? 'block' : 'none';
    nextBtn.style.display = state.currentStep < state.maxSteps ? 'block' : 'none';
    submitBtn.style.display = state.currentStep === state.maxSteps ? 'block' : 'none';

    prevBtn.style.flex = prevBtn.style.display === 'none' ? '0' : '1';
    nextBtn.style.flex = nextBtn.style.display === 'none' ? '0' : '1';
    submitBtn.style.flex = submitBtn.style.display === 'none' ? '0' : '1';
    
    document.getElementById('formMessage').style.display = 'none';
}

function validateStepData() {
    if (state.currentStep === 1) {
        if (!document.getElementById('claimName').value.trim() || !document.getElementById('claimEmail').value.trim()) {
            return flashErrorMessage('Completa tu nombre completo y correo.');
        }
    } else if (state.currentStep === 2) {
        if (!state.selectedCategory) {
            return flashErrorMessage('Haz click sobre una de las categorías para seleccionarla.');
        }
    } else if (state.currentStep === 3) {
        if (!state.selectedUrgency) {
            return flashErrorMessage('Selecciona el nivel de urgencia del incidente.');
        }
    } else if (state.currentStep === 4) {
        if (!state.currentLocation && !document.getElementById('claimAddress').value.trim()) {
            return flashErrorMessage('Registra tu ubicación por GPS o tipea la calle física.');
        }
    } else if (state.currentStep === 5) {
        if (!document.getElementById('claimDescription').value.trim()) {
            return flashErrorMessage('Escribe una descripción del incidente.');
        }
    }
    return true;
}

function flashErrorMessage(text) {
    const msg = document.getElementById('formMessage');
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.background = '#fee2e2';
    msg.style.color = '#dc2626';
    return false;
}

function triggerGPSCapture() {
    const box = document.getElementById('locationDisplay');
    box.innerHTML = '⌛ Localizando...';
    box.style.display = 'block';

    if (!navigator.geolocation) {
        box.innerHTML = '❌ Tu navegador no soporta GPS.';
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            state.currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            box.innerHTML = `✓ Geolocalizado (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`;
        },
        () => { box.innerHTML = '⚠️ GPS no disponible. Escribe la dirección manualmente.'; }
    );
}

function processPhotoFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5242880) {
        alert("La imagen excede los 5MB permitidos. Por favor subí una foto de menor peso.");
        clearPhotoEvidencia();
        return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
        state.currentPhoto = ev.target.result;
        document.getElementById('photoDropZone').style.display = 'none';
        document.getElementById('photoPreview').style.display = 'block';
        document.getElementById('photoImg').src = state.currentPhoto;
    };
    reader.readAsDataURL(file);
}

function clearPhotoEvidencia() {
    state.currentPhoto = null;
    document.getElementById('claimPhoto').value = '';
    document.getElementById('photoDropZone').style.display = 'block';
    document.getElementById('photoPreview').style.display = 'none';
}

function executeSubmitForm() {
    const randomSuffix = String(Date.now()).slice(-4);
    const claimId = `OLV-${new Date().getFullYear()}-${randomSuffix}`;

    const newClaimObject = {
        id: Date.now(),
        claimId,
        name: document.getElementById('claimName').value.trim(),
        email: document.getElementById('claimEmail').value.trim(),
        category: state.selectedCategory,
        urgency: state.selectedUrgency,
        address: document.getElementById('claimAddress').value.trim() || 'Ubicación Satelital GPS',
        description: document.getElementById('claimDescription').value.trim(),
        lat: state.currentLocation?.lat || OLAVARRIA_LAT + (Math.random() - 0.5) * 0.01,
        lng: state.currentLocation?.lng || OLAVARRIA_LNG + (Math.random() - 0.5) * 0.01,
        photo: state.currentPhoto,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    state.claims.push(newClaimObject);
    saveDataToStorage();
    renderPublicClaimsList();
    renderMapPins();

    const msg = document.getElementById('formMessage');
    msg.style.display = 'block';
    msg.style.background = '#dcfce7';
    msg.style.color = '#15803d';
    msg.textContent = `✓ Reporte guardado con éxito. ID: ${claimId}`;

    setTimeout(() => {
        document.getElementById('claimModal').classList.add('hidden');
        if (state.isAdmin) syncAdminDashboard();
    }, 1600);
}

function resetFormState() {
    state.currentStep = 1;
    state.selectedCategory = null;
    state.selectedUrgency = null;
    state.currentLocation = null;
    state.currentPhoto = null;
    document.getElementById('claimName').value = '';
    document.getElementById('claimEmail').value = '';
    document.getElementById('claimAddress').value = '';
    document.getElementById('claimDescription').value = '';
    document.getElementById('locationDisplay').style.display = 'none';
    document.querySelectorAll('.category-option').forEach(o => o.classList.remove('selected'));
    clearPhotoEvidencia();
    refreshFormWizardSteps();
}

function calculateTimeElapsed(isoString) {
    if (!isoString) return 'Reciente';
    const created = new Date(isoString);
    const now = new Date();
    const diffTime = Math.abs(now - created);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Creado hoy';
    if (diffDays === 1) return 'Hace 1 día';
    return `Hace ${diffDays} días`;
}

function getColorByUrgency(urgency) {
    return URGENCY_COLORS[urgency]?.color || URGENCY_COLORS.normal.color;
}

function renderMapPins() {
    state.markers.forEach(m => state.map.removeLayer(m));
    state.markers = [];

    let visibleList = state.isAdmin ? state.claims : state.claims.filter(c => c.status === 'approved');

    if (state.activeCategoryFilter !== 'all') {
        visibleList = visibleList.filter(c => c.category === state.activeCategoryFilter);
    }

    visibleList.forEach(claim => {
        const cat = CATEGORIES[claim.category] || { icon: '🚧', label: 'Incidente' };
        const pinColor = getColorByUrgency(claim.urgency);

        const iconHtml = L.divIcon({
            html: `<div style="background:${pinColor}; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; border:2px solid white; box-shadow:0 3px 6px rgba(0,0,0,0.2);">${cat.icon}</div>`,
            className: 'custom-div-icon',
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });

        const markerOptions = { icon: iconHtml };
        
        // Agregar propiedad draggable únicamente si es admin
        if (state.isAdmin) {
            markerOptions.draggable = true;
        }

        const marker = L.marker([claim.lat, claim.lng], markerOptions).addTo(state.map);
        
        // Evento dragend para guardar nuevas coordenadas si es admin
        if (state.isAdmin) {
            marker.on('dragend', function(e) {
                const newLat = e.target.getLatLng().lat;
                const newLng = e.target.getLatLng().lng;
                
                claim.lat = newLat;
                claim.lng = newLng;
                saveDataToStorage();
            });
        }
        
        let photoSubHtml = '';
        if (claim.photo) {
            photoSubHtml = `<div class="popup-img-container"><img src="${claim.photo}" class="popup-mini-img"></div>`;
        }
        
        const timeElapsed = calculateTimeElapsed(claim.createdAt);

        const popupContent = `
            <div class="custom-popup">
                ${photoSubHtml}
                <div class="popup-title">${cat.icon} ${cat.label}</div>
                <div class="popup-meta">📍 ${claim.address}</div>
                <div class="popup-time">🕒 ${timeElapsed}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow(${claim.id})">Ver más detalles</button>
            </div>
        `;
        marker.bindPopup(popupContent);
        state.markers.push(marker);
    });
}

window.globalOpenDetailWindow = function(id) {
    const claim = state.claims.find(c => c.id === id);
    if (!claim) return;

    const cat = CATEGORIES[claim.category] || { icon: '🚧', label: 'Reclamo' };
    const urgency = URGENCY_COLORS[claim.urgency] || URGENCY_COLORS.normal;
    const dateFormatted = claim.createdAt ? new Date(claim.createdAt).toLocaleDateString('es-AR') : 'Reciente';
    const timeElapsed = calculateTimeElapsed(claim.createdAt);

    let html = `
        <div class="detail-card">
            <div class="detail-label">Código de Seguimiento</div>
            <div class="detail-value" style="font-family:monospace; color:#1e293b; letter-spacing:0.5px;">${claim.claimId}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Categoría del Incidente</div>
            <div class="detail-value">${cat.icon} ${cat.label}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Nivel de Urgencia</div>
            <div class="detail-value" style="color: ${urgency.color}; font-weight: 700;">${urgency.label}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Ubicación Registrada</div>
            <div class="detail-value">📍 ${claim.address}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Antigüedad del Reporte</div>
            <div class="detail-value">📅 ${dateFormatted} (${timeElapsed})</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Declaración del Vecino</div>
            <div class="detail-value" style="font-weight:400; line-height:1.5; color:#334155;">"${claim.description}"</div>
        </div>
    `;

    if (claim.photo) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Evidencia Fotográfica</div>
                <img src="${claim.photo}" class="detail-img">
            </div>
        `;
    }

    if (state.isAdmin) {
        html += `
            <div class="detail-card" style="background:#f0f7ff; border-color:#bae6fd;">
                <div class="detail-label" style="color:#0369a1;">🔑 Auditoría Gubernamental Interna</div>
                <div class="detail-value" style="font-size:12px; font-weight:500; color:#0c4a6e; line-height: 1.4;">
                    <strong>Vecino Emisor:</strong> ${claim.name}<br>
                    <strong>Email de Contacto:</strong> ${claim.email}<br>
                    <strong>Estado Actual:</strong> <span style="text-transform:uppercase; font-weight:700;">${claim.status}</span>
                </div>
            </div>
            <div class="detail-actions">
                <button class="btn-action btn-approve" onclick="dispatchStatus(${claim.id}, 'approved')">Aprobar Caso</button>
                <button class="btn-action btn-reject" onclick="dispatchStatus(${claim.id}, 'rejected')">Descartar</button>
            </div>
        `;
    }

    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailPanel').classList.add('visible');
    
    state.map.closePopup();
    document.getElementById('recentClaimsPopup').classList.add('hidden');
};

function dispatchStatus(id, newStatus) {
    const claim = state.claims.find(c => c.id === id);
    if (claim) {
        claim.status = newStatus;
        saveDataToStorage();
        renderPublicClaimsList();
        renderMapPins();
        if (state.isAdmin) syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');
    }
}

function renderPublicClaimsList() {
    let approved = state.claims.filter(c => c.status === 'approved');
    
    if (state.activeCategoryFilter !== 'all') {
        approved = approved.filter(c => c.category === state.activeCategoryFilter);
    }

    document.getElementById('claimCounter').textContent = approved.length;

    const html = approved.map(claim => {
        const cat = CATEGORIES[claim.category] || { icon: '🚧', label: 'Reclamo' };
        return `
            <div class="claim-item" onclick="globalOpenDetailWindow(${claim.id})">
                <div class="claim-item-header">
                    <span class="claim-item-id">${claim.claimId}</span>
                    <span class="claim-item-status">Validado</span>
                </div>
                <div class="claim-item-name">${cat.icon} ${cat.label}</div>
                <div class="claim-item-desc">${claim.description.substring(0, 55)}...</div>
            </div>
        `;
    }).join('');
    document.getElementById('claimsList').innerHTML = html || '<div style="padding:16px; font-size:11px; color:#64748b; text-align:center; font-weight:600;">Sin reportes para esta sección.</div>';
}

function syncAdminDashboard() {
    document.getElementById('adminStatTotal').textContent = state.claims.length;
    document.getElementById('adminStatPending').textContent = state.claims.filter(c => c.status === 'pending').length;
    const currentSection = document.querySelector('.admin-nav .nav-btn.active').dataset.section;
    renderAdminViewCards(currentSection);
}

function renderAdminViewCards(section) {
    const targets = state.claims.filter(c => c.status === section);
    const html = targets.map(claim => {
        const cat = CATEGORIES[claim.category] || { icon: '🚧', label: 'Reclamo' };
        return `
            <div class="admin-card">
                <div class="admin-card-id">${claim.claimId}</div>
                <div class="admin-card-name">${cat.icon} por ${claim.name}</div>
                <div class="admin-card-text">"${claim.description.substring(0, 80)}..."</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow(${claim.id})">Inspeccionar Incidentes</button>
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
        }
        if (display) {
            display.textContent = `Transcurrido: ${percentComplete.toFixed(1)}% (${daysRemaining} días restantes)`;
        }
    };

    run();
    setInterval(run, 60000);

    const block = document.querySelector('.political-counter');
    if (block) {
        block.style.cursor = 'pointer'; 
        block.addEventListener('dblclick', () => {
            const intento = prompt('🔑 Ingrese la palabra clave de administración:');
            if (intento === ADMIN_CODE) {
                state.isAdmin = true;
                document.getElementById('adminSessionBar').style.display = 'flex';
                syncAdminDashboard(); 
                renderMapPins(); 
                alert('🔓 Modo Auditor Activado correctamente.');
            } else if (intento !== null) {
                alert('❌ Clave incorrecta.');
            }
        });
    }
}

function saveDataToStorage() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.claims)); }
function loadStorageData() { const raw = localStorage.getItem(STORAGE_KEY); state.claims = raw ? JSON.parse(raw) : []; }