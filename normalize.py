"""normalize.py — clean company data on its way into the findings database.

Pure functions (no network, no files), used by findings_db.py when it saves
and by scripts/clean_companies.py to tidy what is already saved:

    fold(text)                 a matching key: case, accents, Arabic / Persian
                               letter variants and punctuation don't matter
    clean_name(name, domain)   page titles cut to the name, ALL CAPS fixed
    clean_category(label)      one spelling per category ("university" →
                               "University")
    site_root(url)             "HTTP://WWW.Acme.com:80/en/x?y" → "http://www.acme.com/"
    same_company(a, b)         are two records the same company? (conservative)
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from typing import Iterable
from urllib.parse import urlparse

# ---- fold: a Unicode-aware matching key ---------------------------------------------

_FOLD_MAP = str.maketrans({
    "ٱ": "ا",            # alef wasla (أ إ آ lose their hamza / madda as marks below)
    "ى": "ي",            # alef maqsura → yeh
    "ة": "ه",            # teh marbuta → heh
    "ی": "ي",            # Persian yeh → Arabic yeh
    "ک": "ك",            # Persian keheh → Arabic kaf
    "ە": "ه",            # ae (ۀ decomposes to it)
    "ـ": "",             # tatweel
    "ı": "i",            # Turkish / Azerbaijani dotless i (İ loses its dot below)
    "ə": "e",            # Azerbaijani schwa
    "ł": "l", "ø": "o", "đ": "d", "æ": "ae", "œ": "oe", "þ": "th",
})


def fold(text: str) -> str:
    """'  Ağ Akademİ — Bakı! ' → 'ag akademi baki'; 'أكاديمية' == 'اكاديميه'.
    NFKC, casefold, Arabic/Persian letter variants unified, diacritics and
    tatweel removed, digits made ASCII, punctuation → spaces, spaces collapsed."""
    s = unicodedata.normalize("NFKC", str(text or "")).casefold().translate(_FOLD_MAP)
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    s = "".join(str(unicodedata.decimal(c)) if c.isdigit() and unicodedata.decimal(c, None) is not None
                else c for c in s)
    s = s.translate(_FOLD_MAP)  # letters that only appear after decomposition (ۀ → ە)
    return " ".join(re.sub(r"[\W_]+", " ", s).split())


# ---- domains ------------------------------------------------------------------------

# Second-level labels that come before a country code: acme.com.eg, aesma.edu.az.
_SLD = {"co", "com", "org", "net", "gov", "ac", "edu", "sci", "mil", "gen", "biz", "info", "nic",
        "ltd", "plc", "sch", "nom", "or", "ne", "go", "res", "web", "med", "int"}
_DOMAINISH = re.compile(r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/?", re.I)


def domain_label(domain: str) -> str:
    """The registrable name of a domain, without hyphens: 'globalknowledge.com.eg'
    → 'globalknowledge', 'en.pasteur.ac.ir' → 'pasteur', 'nova-academy.com.tr'
    → 'novaacademy'."""
    labels = [x for x in str(domain or "").lower().strip(".").split(".") if x]
    if len(labels) >= 3 and labels[-2] in _SLD:
        label = labels[-3]
    elif len(labels) >= 2:
        label = labels[-2]
    else:
        label = labels[0] if labels else ""
    return label.replace("-", "")


def labels_compatible(a: str, b: str) -> bool:
    """Do two domains name the same thing? Same registrable label, or one (of
    at least 4 letters) contained in the other: aesma.az ~ aesma.edu.az,
    nkpi.az ~ ameankpi.org; ilc.az ~ ilc.bh too — the name test decides."""
    la, lb = domain_label(a), domain_label(b)
    if not la or not lb:
        return False
    if la == lb:
        return True
    short, long_ = sorted((la, lb), key=len)
    return len(short) >= 4 and short in long_


# ---- site_root -----------------------------------------------------------------------

def site_root(url: str) -> str:
    """The site's home page: scheme + host + "/" — path, query, fragment and
    default ports dropped, host lower-cased, "www." kept as given. Without a
    scheme it is "http://" (https isn't guessed without asking the site)."""
    u = str(url or "").strip()
    if not u:
        return ""
    if u.startswith("//"):
        u = "http:" + u
    elif "://" not in u:
        u = "http://" + u
    p = urlparse(u)
    scheme = p.scheme.lower()
    if scheme not in ("http", "https"):
        return str(url).strip()
    host = (p.hostname or "").strip(".").lower()
    if not host:
        return str(url).strip()
    if ":" in host:  # IPv6
        host = f"[{host}]"
    try:
        port = p.port
    except ValueError:
        port = None
    if port and port != {"http": 80, "https": 443}[scheme]:
        host += f":{port}"
    return f"{scheme}://{host}/"


def has_path(url: str) -> bool:
    """Does the address point below the site's home page (a path, query or fragment)?"""
    u = str(url or "").strip()
    if not u:
        return False
    p = urlparse(u if "://" in u or u.startswith("//") else "http://" + u)
    return p.path not in ("", "/") or bool(p.query) or bool(p.fragment)


def site_host(url: str) -> str:
    """The site's host without "www.": 'https://www.Acme.com/x' → 'acme.com'."""
    root = site_root(url)
    host = root.split("://", 1)[1].rstrip("/") if "://" in root else ""
    return host[4:] if host.startswith("www.") else host


# ---- clean_name ------------------------------------------------------------------------

# " | " and friends separate a page title's parts; dashes may be part of a name.
_STRONG_SEP = re.compile(r"\s+(?:\||::|·|•|●|»)\s+|\s*｜\s*")
_DASH_SEP = re.compile(r"\s+[-–—]\s+")
_ANY_SEP = re.compile(_STRONG_SEP.pattern + r"|" + _DASH_SEP.pattern)

_GENERIC_PARTS = {fold(x) for x in (
    "Home", "Homepage", "Home page", "Official site", "Official website", "Official web site",
    "Welcome", "Main page", "Index", "Start", "Ana Sayfa", "Anasayfa", "Ana səhifə", "Əsas səhifə",
    "الرئيسية", "الصفحة الرئيسية", "صفحة رئيسية", "صفحه اصلی", "Главная", "Главная страница",
)}
_WELCOME = re.compile(r"^\s*(?:welcome to|hoş geldiniz|xoş gəlmisiniz)\s+", re.I)


def _script(text: str) -> str:
    """The main script of a text ('latin', 'arabic', …), by letter count."""
    counts: Counter = Counter()
    for c in text:
        if c.isalpha():
            counts[unicodedata.name(c, "OTHER ?").split()[0]] += 1
    return counts.most_common(1)[0][0] if counts else ""


def _domain_score(part: str, label: str) -> int:
    """How much of the domain's name a title part spells (longest common run)."""
    a = fold(part).replace(" ", "")
    if not a or not label:
        return 0
    m = SequenceMatcher(None, a, label, autojunk=False).find_longest_match(0, len(a), 0, len(label))
    return m.size


def _is_junk_part(part: str) -> bool:
    return not fold(part) or fold(part) in _GENERIC_PARTS or bool(_DOMAINISH.fullmatch(part.strip()))


def _pick(parts: list[str], label: str) -> str:
    """The part that best looks like the name: the first, unless another
    spells clearly more of the domain's name."""
    best = parts[0]
    s0 = _domain_score(best, label)
    top = s0
    for p in parts[1:]:
        if p[:1].islower():
            continue  # "study in Egypt" is a description, not a name
        s = _domain_score(p, label)
        if s >= 4 and s >= s0 + 3 and s > top:
            best, top = p, s
    return best


def _is_tagline(tail: str, head: str) -> bool:
    """A dash tail that is a description, not part of the name: long, in
    another script (a bilingual name), or generic."""
    if _is_junk_part(tail):
        return True
    words = re.findall(r"[^\W\d_]+", tail)
    if len(words) >= 4:
        return True
    sh, st = _script(head), _script(tail)
    return bool(sh and st and sh != st)


def _split(name: str, sep: re.Pattern) -> list[str]:
    """Split at separators outside brackets: 'Amaq (PopularCert - ISO)' stays whole."""
    parts, start = [], 0
    for m in sep.finditer(name):
        before = name[:m.start()]
        if before.count("(") > before.count(")") or before.count("[") > before.count("]"):
            continue
        parts.append(name[start:m.start()].strip())
        start = m.end()
    parts.append(name[start:].strip())
    return parts


def _cut_title(name: str, label: str) -> str:
    if len(_split(name, _STRONG_SEP)) > 1:
        parts = _split(name, _ANY_SEP)
    elif len(_split(name, _DASH_SEP)) > 1:
        parts = _split(name, _DASH_SEP)
        head, tail = parts[0], " - ".join(parts[1:])
        if not head or not _is_tagline(tail, head):
            return name  # part of the name: "College of Medicine - Nahrain University"
    else:
        return name
    parts = [p for p in parts if not _is_junk_part(p)]
    return _pick(parts, label) if parts else name


# Short words that are words, not acronyms, in an ALL CAPS name.
_LOWER_WORDS = {"of", "and", "the", "in", "for", "at", "on", "to", "by", "with", "from",
                "de", "la", "le", "du", "des", "ve", "ile", "için", "və", "üçün", "und", "fur", "für"}
_COMMON_SHORT = {"holy", "new", "city", "high", "home", "best", "top", "star", "gulf", "arab", "oil",
                 "gas", "care", "plus", "pro", "one", "art", "life", "land", "sea", "sky", "gold",
                 "blue", "al", "el", "abu", "bin", "ibn", "dar", "nur", "iraq", "iran", "oman",
                 "baku", "tech", "data", "team", "work", "west", "east", "north", "south",
                 "özel", "dil", "kurs", "okul", "ilk", "yeni", "türk", "iş", "spor", "kız", "ana",
                 "evi", "yurt", "bakı", "dili"}
_ENGLISH_HINT = re.compile(r"W|X|Q|SH|TH|PH|CK|ION|IE|EA|OO|EE")


def _lower(word: str, turkic: bool) -> str:
    if turkic and not _ENGLISH_HINT.search(word.upper()):
        word = word.replace("I", "ı")
    return word.replace("İ", "i").lower()


def _fix_caps(name: str) -> str:
    """'CLEVEREST ACADEMY' → 'Cleverest Academy'; 'STS TRAINING CENTER' →
    'STS Training Center'; 'GÜVENLİK EĞİTİM' → 'Güvenlik Eğitim'. Leaves
    one-word names ('RECAP') and mixed-case names alone."""
    letters = [c for c in name if c.isalpha()]
    cased = [c for c in letters if c.isupper() or c.islower()]
    if len(cased) < 4 or any(c.islower() for c in cased) or len(cased) < 0.6 * len(letters):
        return name
    words = re.findall(r"[^\W\d_]+", name)
    if len(name.split()) < 2 or not any(len(w) > 4 for w in words):
        return name
    turkic = bool(re.search("[İŞĞƏ]", name))

    def one(m: re.Match) -> str:
        w, i = m.group(0), m.start()
        if i and name[i - 1] in "'’":
            return _lower(w, turkic)                        # CHILDREN'S → Children's
        key = _lower(w, turkic)
        if i and key in _LOWER_WORDS:
            return key
        if len(w) <= 4 and key not in _COMMON_SHORT and key not in _LOWER_WORDS:
            return w                                       # IDP, ACAD, STS
        return w[0] + _lower(w[1:], turkic)

    return re.sub(r"[^\W\d_]+", one, name)


def clean_name(name: str, domain: str = "") -> tuple[str, bool]:
    """A company's name from what a source called it: page-title tails cut
    ('CLEVEREST ACADEMY | Xaricə Təhsil | …' → 'Cleverest Academy'), ALL CAPS
    fixed, spaces tidied. A name that is just a domain stays as it is.
    Returns (clean, changed)."""
    raw = str(name or "")
    s = " ".join(raw.split())
    if not s:
        return s, s != raw
    label = domain_label(domain)
    if not _DOMAINISH.fullmatch(s):
        s = _WELCOME.sub("", s) or s
        s = _cut_title(s, label).strip(" -–—|:·,")
        s = _fix_caps(s) or raw.strip()
    return s, s != raw


# ---- categories ---------------------------------------------------------------------------

# Conservative synonyms (keyed by fold()): spellings of the same category.
_CATEGORY_SYNONYMS = {fold(k): v for k, v in {
    "non-profit organization": "Non-profit organization",
    "nonprofit organization": "Non-profit organization",
    "non-profit organisation": "Non-profit organization",
    "nonprofit organisation": "Non-profit organization",
    "not-for-profit organization": "Non-profit organization",
    "non-governmental organization": "Non-governmental organization",
    "non-governmental organisation": "Non-governmental organization",
    "nongovernmental organization": "Non-governmental organization",
    "organisation": "Organization",
    "training centre": "Training center",
    "education centre": "Education center",
    "learning centre": "Learning center",
    "research centre": "Research center",
}.items()}


def _tidy_label(label: str) -> str:
    return " ".join(str(label or "").split()).strip(" ,;")


def category_spellings(labels: Iterable[str]) -> dict[str, str]:
    """The most common spelling of each category, by its case-insensitive
    key ({'university': 'university'} when that's how most records spell it);
    clean_category() then capitalises it."""
    counts: dict[str, Counter] = {}
    for label in labels:
        s = _tidy_label(label)
        if s:
            counts.setdefault(s.casefold(), Counter())[s] += 1
    return {k: c.most_common(1)[0][0] for k, c in counts.items()}


def clean_category(label: str, spellings: dict[str, str] | None = None) -> str:
    """One canonical spelling per category: trimmed, first letter capital,
    the rest as most records spell it ('university' / 'University' →
    'University'), a few synonyms unified ('Training centre' → 'Training center')."""
    s = _tidy_label(label)
    if not s:
        return ""
    syn = _CATEGORY_SYNONYMS.get(fold(s))
    if syn:
        return syn
    if spellings:
        s = spellings.get(s.casefold(), s)
    return s[0].upper() + s[1:]


def clean_categories(labels: Iterable[str], spellings: dict[str, str] | None = None) -> list[str]:
    """clean_category() over a list, duplicates (any case) dropped, order kept."""
    out: dict[str, str] = {}
    for label in labels or []:
        c = clean_category(label, spellings)
        if c:
            out.setdefault(c.casefold(), c)
    return list(out.values())


# ---- same_company -------------------------------------------------------------------------

# Legal forms at the end of a name (fold()ed: punctuation is already spaces).
_LEGAL_SUFFIXES = sorted({fold(x) for x in (
    "LLC", "L.L.C", "Ltd", "Limited", "MMC", "ASC", "QSC", "QPSC", "QFZ", "FZE", "FZCO", "FZC",
    "FZ-LLC", "FZ LLC", "W.L.L", "WLL", "SPC", "SAOC", "SAOG", "Co", "Inc", "Corp", "Corporation",
    "PLC", "GmbH", "AG", "SA", "SARL", "JSC", "OJSC", "CJSC", "A.Ş", "Ltd. Şti", "Şti", "Group",
    "ذ.م.م", "ش.م.م",
)}, key=len, reverse=True)

# Hosts many unrelated companies share: the same "website" there proves nothing.
_SHARED_HOSTS = {"facebook.com", "instagram.com", "linkedin.com", "sites.google.com", "google.com",
                 "linktr.ee", "wa.me", "t.me", "business.site", "twitter.com", "x.com", "youtube.com",
                 "m.facebook.com", "business.google.com", "maps.google.com", "goo.gl", "bit.ly"}


def core_name(name: str) -> str:
    """fold() of a name without a leading "the" and trailing legal forms:
    'The Acme Group W.L.L.' → 'acme'."""
    s = fold(name)
    s = re.sub(r"^the ", "", s)
    changed = True
    while changed and s:
        changed = False
        for suf in _LEGAL_SUFFIXES:
            if s.endswith(" " + suf):
                s = s[: -len(suf) - 1].rstrip()
                changed = True
                break
    return s


def _rec_domain(rec: dict) -> str:
    return str(rec.get("id") or site_host(rec.get("website") or ""))


def same_company(a: dict, b: dict) -> bool:
    """Are two records the same company? Yes when their websites are the same
    site, or when their names match (case, accents, legal forms aside) AND
    their domains name the same thing (globalknowledge.com ~
    globalknowledge.com.eg). Conservative: a wrong merge is worse than a
    missed one."""
    da, db = _rec_domain(a), _rec_domain(b)
    if da and da == db:
        return True
    ha, hb = site_host(a.get("website") or ""), site_host(b.get("website") or "")
    if ha and ha == hb and ha not in _SHARED_HOSTS:
        return True
    na = core_name(clean_name(a.get("name") or "", da)[0])
    nb = core_name(clean_name(b.get("name") or "", db)[0])
    if not na or na != nb or len(na.replace(" ", "")) < 4:
        return False
    if _DOMAINISH.fullmatch(str(a.get("name") or "").strip()):
        return False  # a "name" that is a domain says nothing more
    return labels_compatible(da, db)
