let mapsData = [];

function init()
{
    // All data is embedded inline at build time; no runtime fetch.
    const data = typeof MAPS_DATA !== 'undefined' ? MAPS_DATA : window.MAPS_DATA;
    if( Array.isArray(data) && data.length > 0 )
    {
        mapsData = data;
        handleRouter();
    }
    else
    {
        console.error("MAPS_DATA missing or invalid");
        document.getElementById('mapTableBody').innerHTML =
            '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Failed to load map archive data.</td></tr>';
    }
}

function renderList(maps)
{
    const tbody = document.getElementById('mapTableBody');
    tbody.innerHTML = '';

    if( !Array.isArray(maps) )
    {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Invalid map data received.</td></tr>';
        return;
    }

    if( maps.length === 0 )
    {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #888;">No maps found.</td></tr>';
        return;
    }

    for( const m of maps )
    {
        // Skip entries with missing name field or invalid structure
        if( !m || !m.name || typeof m.name !== 'string' ) 
            continue;
        
        const tr = document.createElement('tr');
        const rating = typeof m.rating === 'number' && !Number.isNaN(m.rating)
            ? m.rating.toFixed(1)
            : '–';

        // BSP column: show first filename or dash (JSON key is "bsp")
        const bspText = Array.isArray(m.bsp) && m.bsp.length > 0
            ? escapeHtml(m.bsp[0])
            : (typeof m.bsp === 'string' ? escapeHtml(m.bsp) : '—');
        tr.innerHTML = `
            <td><strong><a href="#map/${encodeURIComponent(m.name)}">${escapeHtml(m.name)}</a></strong></td>
            <td>${escapeHtml(m.author || 'Unknown')}</td>
            <td>${escapeHtml(m.difficulty || 'Unrated')}</td>
            <td>${escapeHtml(rating)} / 5</td>
            <td>${bspText}</td>
        `;
        tbody.appendChild(tr);
    }
}

function filterMaps()
{
    const query = document.getElementById('searchInput').value.toLowerCase().trim();

    if( !query )
    {
        renderList(mapsData);
        return;
    }

    const filtered = mapsData.filter( m =>
    {
        // Check for missing or invalid entries
        if( !m || typeof m.name !== 'string' )
            return false;

        return (m.name || '').toLowerCase().includes(query) ||
            (m.author || '').toLowerCase().includes(query) ||
            (m.summary || '').toLowerCase().includes(query) ||
            (m.tags || []).some(t => t.toLowerCase().includes(query)) ||
            // Also search BSP (map file) names with partial matching
            (Array.isArray(m.bsp) && m.bsp.some(b => b.toLowerCase().includes(query)));
    });

    renderList(filtered);
}

function handleRouter()
{
    const hash = window.location.hash;
    const listView = document.getElementById('listView');
    const detailView = document.getElementById('detailView');

    if( hash && hash.startsWith('#map/') )
    {
        const mapName = decodeURIComponent(hash.replace('#map/', ''));
        // Find map case-insensitively
        const map = mapsData.find(m => {
            if (!m || typeof m.name !== 'string') return false;
            return (m.name || '').toLowerCase() === mapName.toLowerCase();
        });

        if( map )
        {
            showDetail(map);
            listView.classList.add('hidden');
            detailView.classList.remove('hidden');
            window.scrollTo(0, 0);
            return;
        }
    }

    listView.classList.remove('hidden');
    detailView.classList.add('hidden');
    renderList(mapsData);
}

function showDetail(m)
{
    const titleEl = document.getElementById('detailTitle');
    const authorEl = document.getElementById('detailAuthor');
    const difficultyEl = document.getElementById('detailDifficulty');
    const sizeEl = document.getElementById('detailSize');
    const ratingEl = document.getElementById('detailRating');

    titleEl.innerText = m.name || 'Unknown Map';
    authorEl.innerText = m.author || 'Unknown';
    difficultyEl.innerText = m.difficulty ? cap(m.difficulty) : 'Unrated';
    sizeEl.innerText = m.size ? cap(m.size) : 'Unknown';
    ratingEl.innerText = typeof m.rating === 'number' && !Number.isNaN(m.rating)
        ? `${m.rating.toFixed(1)} / 5`
        : 'Unrated';

    // BSP row: show filenames, hide the row entirely when absent
    const bspText = Array.isArray(m.bsp) && m.bsp.length > 0
        ? m.bsp.join(', ')
        : null;
    toggleRow('detailBspRow', 'detailBsp', bspText);
    toggleRow('detailReleaseRow', 'detailRelease', m.release_date || null);
    toggleRow('detailOrigReleaseRow', 'detailOrigRelease', m.original_release || null);

    const downloadBtn = document.getElementById('detailDownload');
    const mirrorsEl = document.getElementById('detailMirrors');

    // Download button: active link or grayed-out placeholder
    if( isHttp(m.download_url) )
    {
        downloadBtn.href = m.download_url;
        downloadBtn.textContent = 'Download Map';
        downloadBtn.classList.remove('btn-none');
        downloadBtn.classList.add('btn-download');
    }
    else
    {
        downloadBtn.removeAttribute('href');
        downloadBtn.textContent = 'No download available!';
        downloadBtn.classList.remove('btn-download');
        downloadBtn.classList.add('btn-none');
    }
    // Mirrors: labeled links below the main button (http/https only)
    const mirrors = (Array.isArray(m.mirrors) ? m.mirrors : []).filter(x => x && isHttp(x.url));
    if (mirrors.length > 0)
    {
        mirrorsEl.innerHTML = '<strong>Mirrors:</strong> ' + mirrors.map(x =>
            `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.label || x.url)}</a>`
        ).join(' · ');
        mirrorsEl.style.display = '';
    }
    else
    {
        mirrorsEl.innerHTML = '';
        mirrorsEl.style.display = 'none';
    }

    const originalLink = document.getElementById('detailOriginal');
    if( originalLink && m.url && m.url !== '' )
    {
        originalLink.href = m.url;
        originalLink.style.display = 'inline-block';
    } 
    else if( originalLink) 
        originalLink.style.display = 'none';
    // Content is embedded in the data — render directly, no fetch
    const contentEl = document.getElementById('detailContent');
    let html = '';
    if( Array.isArray(m.screenshots) && m.screenshots.length )
    {
        html += '<h2>Screenshots</h2><div class="screenshot-strip">';
        for (const src of m.screenshots.slice(0, 12))
        {
            const alt = escapeHtml( m.name || 'Screenshot' );
            html += `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">` +
                    `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">` +
                    `</a>`;
        }

        html += '</div>';
    }
    // Content sections. The HTML was sanitized at build time by
    // sanitizeElement() (script/iframe/style/embed removed, attributes
    // stripped except a[href,target,rel] and img[src,alt]), so render as-is.
    if( m.description )
        html += '<h2>Description</h2>' + m.description;

    if( m.additional )
        html += '<h2>Additional Info</h2>' + m.additional;
    
    if( m.known_issues && m.known_issues !== '' )
        html += '<h2>Known Issues</h2><p>' + escapeHtml(m.known_issues) + '</p>';
    
    contentEl.innerHTML = html || '<p style="color:#888;">No page content available for this map.</p>';
}

function toggleRow(rowId, spanId, value)
{
    const row = document.getElementById( rowId );
    const span = document.getElementById( spanId );

    if( !row || !span ) 
        return;

    if( value )
    {
        span.innerText = value;
        row.style.display = '';
    }
    else 
        row.style.display = 'none';
    
}

function cap(s)
{
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// isHttp allows only http(s) URLs as link targets.
function isHttp(u)
{
    return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function escapeHtml(str)
{
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

window.addEventListener('hashchange', handleRouter);
window.addEventListener('DOMContentLoaded', init);
