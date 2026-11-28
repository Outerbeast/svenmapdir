let mapsData = [];
// The currently displayed (filtered) subset. Kept so changing the sort does
// not throw away an active search filter.
let visibleMaps = [];

// Sort state. `field: ''` means "original order".
let currentSort = {
    field: 'release_date',   // Page opens newest-first; '' = unsorted
    direction: 'desc'        // asc or desc
};

// Every sortable field lives here. Adding an entry automatically adds a
// dropdown option; displayed columns also become clickable headers.
const SORT_FIELDS = [
    { key: 'name',         label: 'Map Name',   type: 'string' },
    { key: 'author',       label: 'Author',     type: 'string' },
    { key: 'difficulty',   label: 'Difficulty', type: 'enum',   enumMap: { easy: 0, medium: 1, hard: 2 } },
    { key: 'size',         label: 'Size',       type: 'enum',   enumMap: { small: 0, medium: 1, large: 2 } },
    { key: 'rating',       label: 'Rating',     type: 'number' },
    { key: 'release_date', label: 'Released',   type: 'date' },
    {
        key: 'bsp',
        label: 'BSP Filename',
        type: 'string',
        // JSON stores BSP names as an array; compare the first filename.
        value: m => Array.isArray(m.bsp) ? (m.bsp[0] || '') : (typeof m.bsp === 'string' ? m.bsp : '')
    }
];

// One display column. `field` links it to SORT_FIELDS for header clicks;
// its position in the COLUMNS array is the visible column order.
class Column
{
    constructor({ field, label, width, cell, cellClass = '', title = null })
    {
        this.field = field;
        this.label = label;
        this.width = width;     // percent width for the generated <colgroup>
        this.cell = cell;       // m => HTML string for one <td>
        this.cellClass = cellClass;
        this.title = title;     // optional m => tooltip text
    }
}

const COLUMNS =
[
    new Column({
        field: 'name', label: 'Map Name', width: 26,
        cell: m => `<strong><a href="#map/${encodeURIComponent(m.name)}">${escapeHtml(m.name)}</a></strong>`
    }),
    new Column({
        field: 'author', label: 'Author', width: 15,
        cell: m => escapeHtml(m.author || 'Unknown')
    }),
    new Column({
        field: 'bsp', label: 'BSP Filename', width: 20,
        cell: m => { const list = bspList(m); return list.length ? escapeHtml(list[0]) : '—'; },
        cellClass: 'bsp-col',
        title: m => bspList(m).join(', ')
    }),
        new Column({
        field: 'release_date', label: 'Released', width: 17,
        cell: m => shortDate(m.release_date)
    }),
    new Column({
        field: 'difficulty', label: 'Difficulty', width: 12,
        cell: m => escapeHtml(m.difficulty || 'Unrated')
    }),
    new Column({
        field: 'rating', label: 'Rating', width: 10,
        cell: m => ratingText(m) + ' / 5'
    })
];

function ratingText(m)
{
    return typeof m.rating === 'number' && Number.isFinite(m.rating) && m.rating > 0
        ? m.rating.toFixed(1)
        : '–';
}

function bspList(m)
{
    if( Array.isArray(m.bsp) )
        return m.bsp.filter( Boolean );

    return typeof m.bsp === 'string' && m.bsp ? [m.bsp] : [];
}

// One option per field; direction is controlled by the separate button.
const SORT_OPTIONS = [
    { value: '', label: 'Unsorted (original order)' },
    ...SORT_FIELDS.map(f => ({ value: f.key, label: f.label }))
];

function init()
{
    // All data is embedded inline at build time; no runtime fetch.
    const data = typeof MAPS_DATA !== 'undefined' ? MAPS_DATA : window.MAPS_DATA;
    if( Array.isArray(data) && data.length > 0 )
    {
        mapsData = data;
        visibleMaps = data;
        setupSortUI();
        handleRouter();
    }
    else
    {
        console.error("MAPS_DATA missing or invalid");
        document.getElementById('mapTableBody').innerHTML =
            '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Failed to load map archive data.</td></tr>';
    }
}

function renderList(maps = visibleMaps)
{
    if( !Array.isArray(maps) )
        maps = mapsData;

    // Remember the current subset so sort changes can re-render it.
    visibleMaps = maps;

    let sortedMaps = [...maps];
    if( currentSort.field )
    {
        const fieldConfig = SORT_FIELDS.find(f => f.key === currentSort.field);
        if( fieldConfig )
            sortedMaps = applySort(sortedMaps, fieldConfig, currentSort.direction);
    }

    updateSortUI();

    const tbody = document.getElementById('mapTableBody');
    tbody.innerHTML = '';

    if( !Array.isArray(sortedMaps) )
    {
        tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" style="text-align: center; color: #ff6b6b;">Invalid map data received.</td></tr>`;
        return;
    }

    if( sortedMaps.length === 0 )
    {
        tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" style="text-align: center; color: #888;">No maps found.</td></tr>`;
        return;
    }

    for( const m of sortedMaps )
    {
        // Skip entries with missing name field or invalid structure
        if( !m || !m.name || typeof m.name !== 'string' )
            continue;

        const tr = document.createElement('tr');
        tr.innerHTML = COLUMNS.map(c =>
        {
            const cls = c.cellClass ? ` class="${c.cellClass}"` : '';
            const title = c.title ? ` title="${escapeHtml(c.title(m))}"` : '';
            return `<td${cls}${title}>${c.cell(m)}</td>`;
        }).join('');
        tbody.appendChild(tr);
    }
}

function applySort(maps, fieldConfig, direction)
{
    if( !fieldConfig || !Array.isArray(maps) )
        return Array.isArray(maps) ? [...maps] : [];

    const getValue = fieldConfig.value || (m => m[fieldConfig.key]);
    const sign = direction === 'desc' ? -1 : 1;

    // Copy first: never mutate mapsData/visibleMaps in place.
    return [...maps].sort((a, b) =>
    {
        const valA = getValue(a), valB = getValue(b);
        const missA = isMissingValue(valA, fieldConfig);
        const missB = isMissingValue(valB, fieldConfig);

        // Missing values always go last, regardless of sort direction.
        if( missA !== missB ) return missA ? 1 : -1;
        if( missA ) return tieBreak(a, b);

        const cmp = compareValues(valA, valB, fieldConfig) * sign;
        return cmp !== 0 ? cmp : tieBreak(a, b);
    });
}

function isMissingValue(value, fieldConfig)
{
    switch( fieldConfig.type )
    {
        case 'number':
            // SCMapDB writes 0 for maps with no rating.
            return typeof value !== 'number' || !Number.isFinite(value) || value <= 0;
        case 'enum':
            return value === undefined || value === null ||
                (fieldConfig.enumMap && fieldConfig.enumMap[String(value).toLowerCase()] === undefined);
        case 'date':
            return !Number.isFinite(parseWikiDate(value));
        case 'string':
        default:
            return value === undefined || value === null || String(value).trim() === '';
    }
}

function compareValues(valA, valB, fieldConfig)
{
    switch( fieldConfig.type )
    {
        case 'number':
            return Number(valA) - Number(valB);
        case 'enum':
            return (fieldConfig.enumMap[String(valA).toLowerCase()] || 0) -
                   (fieldConfig.enumMap[String(valB).toLowerCase()] || 0);
        case 'date':
            return parseWikiDate(valA) - parseWikiDate(valB);
        case 'string':
        default:
            // numeric: true gives natural order ("Map 2" before "Map 10").
            return String(valA).localeCompare(String(valB), undefined,
                { sensitivity: 'base', numeric: true });
    }
}

// Stable, predictable order for equal values.
function tieBreak(a, b)
{
    const an = typeof a.name === 'string' ? a.name : '';
    const bn = typeof b.name === 'string' ? b.name : '';
    return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true });
}

const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
};
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Wiki data uses plain and non-breaking spaces, and formats such as
// "Final - November 12, 2004", "Test 2 - 9 January, 2004", "Final - 2004".
function parseDateParts(value)
{
    if( typeof value !== 'string' ) return null;

    const s = value.replace(/\u00a0/g, ' ').trim();
    const monthFirst = /\b([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
    const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})\b/.exec(s);

    if( monthFirst && MONTHS[monthFirst[1].toLowerCase()] !== undefined )
        return { month: MONTHS[monthFirst[1].toLowerCase()], day: parseInt(monthFirst[2], 10),
                 year: parseInt(monthFirst[3], 10) };

    if( dayFirst && MONTHS[dayFirst[2].toLowerCase()] !== undefined )
        return { day: parseInt(dayFirst[1], 10), month: MONTHS[dayFirst[2].toLowerCase()],
                 year: parseInt(dayFirst[3], 10) };

    // Year-only dates ("Final - 2004", "Beta 8.7 - Circa 2014").
    const yearOnly = /(?:19|20)\d{2}/.exec(s);
    return yearOnly ? { year: parseInt(yearOnly[0], 10), month: 0, day: 1, yearOnly: true } : null;
}

function parseWikiDate(value)
{
    const parts = parseDateParts(value);
    return parts ? new Date(parts.year, parts.month, parts.day).getTime() : NaN;
}

// Compact label for the Released column.
function shortDate(value)
{
    const parts = parseDateParts(value);
    if( !parts ) return '—';
    return parts.yearOnly ? String(parts.year)
        : MONTH_ABBR[parts.month] + ' ' + parts.day + ', ' + parts.year;
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

// Clicking a header (or calling this from layout.html) sorts by that field.
// Clicking the active field again flips asc <-> desc; a new field keeps the
// direction already chosen with the button.
function toggleSort(field)
{
    if( !field )
    {
        currentSort.field = 'name';
        currentSort.direction = 'asc';
    }
    else
    {
        if( !SORT_FIELDS.some( f => f.key === field ) )
            return;

        if( currentSort.field === field )
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        else
            currentSort.field = field;
    }

    renderList();
}

// Builds the sort dropdown + direction button and makes the visible <th>
// cells clickable. Done in JS so the generated index.html stays untouched.
function setupSortUI()
{
    const search = document.getElementById( 'searchInput' );
    if( !search || document.getElementById( 'sortSelect' ) )
        return;
    // sneak some hypertext here
    const bar = document.createElement( 'div' );
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;';
    bar.innerHTML =
        '<label for="sortSelect">Sort by:</label>' +
        '<select id="sortSelect" style="padding:8px;background:#1e1e1e;color:#fff;' +
            'border:1px solid #333;border-radius:4px;">' +
            SORT_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('') +
        '</select>' +
        '<button type="button" id="sortDirBtn" style="padding:8px 12px;background:#1e1e1e;' +
            'color:#fff;border:1px solid #333;border-radius:4px;cursor:pointer;"></button>';
    search.parentNode.insertBefore(bar, search.nextSibling);

    // Fixed layout + a colgroup keep the long BSP filenames from stretching the table.
    const style = document.createElement('style');
    style.id = 'sortStyles';
    style.textContent =
        '#listView table { table-layout: fixed; }' +
        '#listView .bsp-col { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }';
    document.head.appendChild(style);

    const tables = document.querySelectorAll('#listView table');
    if( tables.length )
    {
        const colgroup = document.createElement('colgroup');
        colgroup.innerHTML = COLUMNS.map(c => `<col style="width:${c.width}%">`).join('');
        tables[0].insertBefore(colgroup, tables[0].firstChild);
    }

    // Build the header row from COLUMNS so its order always matches the cells.
    const headerRows = document.querySelectorAll('#listView thead tr');
    if( headerRows.length )
    {
        headerRows[0].innerHTML = '';
        for( const c of COLUMNS )
        {
            const th = document.createElement('th');
            th.textContent = c.label;
            if( c.cellClass ) th.classList.add(c.cellClass);
            headerRows[0].appendChild(th);
        }
    }
    document.querySelectorAll('#mapTableBody td[colspan]').forEach(td =>
    {
        td.colSpan = COLUMNS.length;
    });

    document.getElementById('sortSelect').addEventListener('change', e =>
    {
        currentSort.field = e.target.value;
        renderList();
    });

    document.getElementById('sortDirBtn').addEventListener('click', () =>
    {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        renderList();
    });

    document.querySelectorAll('#listView thead th').forEach( (th, i) =>
    {
        const column = COLUMNS[i];
        const config = SORT_FIELDS.find( f => f.key === column.field );
        if( !config )
            return;

        th.dataset.sortLabel = th.textContent.trim();
        th.dataset.sortField = column.field;
        th.style.cursor = 'pointer';
        th.title = 'Sort by ' + config.label;
        th.addEventListener('click', () => toggleSort( column.field) );
    });

    updateSortUI();
}

// Keeps the dropdown, direction button and ↑/↓ header arrows in sync.
function updateSortUI()
{
    const select = document.getElementById('sortSelect');
    if( select )
        select.value = currentSort.field;

    const dirBtn = document.getElementById('sortDirBtn');
    if( dirBtn )
    {
        dirBtn.textContent = currentSort.direction === 'asc' ? '↑ Ascending' : '↓ Descending';
        dirBtn.disabled = !currentSort.field;
        dirBtn.style.opacity = dirBtn.disabled ? '0.5' : '1';
    }

    document.querySelectorAll('#listView thead th[data-sort-field]').forEach(th =>
    {
        const active = th.dataset.sortField === currentSort.field;
        const arrow = active ? (currentSort.direction === 'asc' ? ' ↑' : ' ↓') : '';
        th.textContent = th.dataset.sortLabel + arrow;
    });
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

    // Re-render the current (possibly filtered) subset with the sort applied.
    renderList();
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
