"""normalize.py — matching keys, clean names / categories / websites, duplicates."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from normalize import (  # noqa: E402
    category_spellings, clean_categories, clean_category, clean_name, core_name, domain_label, fold,
    has_path, labels_compatible, same_company, site_root,
)


# ---- fold ---------------------------------------------------------------------------

def test_fold_ignores_case_accents_punctuation_and_spacing():
    assert fold("  Global-Knowledge,  Inc. ") == "global knowledge inc"
    assert fold("Société Générale") == "societe generale"
    assert fold("ＡＣＭＥ") == "acme"                          # NFKC: full-width letters


def test_fold_unifies_arabic_letter_variants():
    assert fold("أكاديمية") == fold("اكاديميه") == fold("إكاديمية")
    assert fold("آل") == fold("ال") and fold("ٱلعلم") == fold("العلم")
    assert fold("مستشفى") == fold("مستشفي")                    # alef maqsura → yeh
    assert fold("مؤسسة") == fold("موسسه") and fold("هيئة") == fold("هييه")
    assert fold("عَرَبِيّ") == fold("عربي")                    # harakat removed
    assert fold("العـــلم") == fold("العلم")                   # tatweel removed
    assert fold("٢٠٢٤") == "2024"                              # Arabic-Indic digits


def test_fold_unifies_persian_and_arabic_yeh_kaf():
    assert fold("کتابی") == fold("كتابي")
    assert fold("ایران") == fold("ايران")
    assert fold("۱۴۰۳") == "1403"                              # Persian digits


def test_fold_turkish_and_azerbaijani_letters():
    assert fold("İSTANBUL") == fold("istanbul") == fold("Istanbul")
    assert fold("Bakı") == "baki" and fold("Akademİ") == "akademi"
    assert fold("Təhsil Mərkəzi") == "tehsil merkezi"
    assert fold("Eğitim Danışmanlık Şirketi") == "egitim danismanlik sirketi"


# ---- clean_name ---------------------------------------------------------------------

@pytest.mark.parametrize("raw, domain, want", [
    # Page titles: the part that is the name.
    ("CLEVEREST ACADEMY | Xaricdə Təhsil | Xarici Dil və YÖS Kursları", "cleverest.az", "Cleverest Academy"),
    ("360 Experiential Solutions | Team Building in Egypt", "360experientialsolutions.com",
     "360 Experiential Solutions"),
    ("Home | Acme Training", "acme.com", "Acme Training"),
    ("Official site - Acme Training Institute LLC", "acme.com", "Acme Training Institute LLC"),
    ("Network Training Center - IT Kurslari | Cisco Kurslari | NTCenter.az", "ntcenter.az",
     "Network Training Center"),
    ("IMP | Institute of Management Professionals", "imanagementpro.com",
     "Institute of Management Professionals"),          # the part that spells the domain
    ("KAF ● BURSA REKLAM AKADEMİ", "bursareklamakademi.com", "Bursa Reklam Akademi"),
    ("OKÇUBABA Geleneksel Okçuluk｜OKCUBABA Traditional Archery", "okcubaba.com",
     "OKÇUBABA Geleneksel Okçuluk"),
    # Dash tails: cut only when they are a description or another language.
    ("Aktif Eğitim Merkezi - Almanca Sınav Hazırlık Ve Eğitim Merkezi", "aktifegitim.com.tr",
     "Aktif Eğitim Merkezi"),
    ("Alnaji University - جامعة الناجي", "alnaji-uni.edu.iq", "Alnaji University"),
    ("IBS Training Academy - أكاديمية أي بي إس للتدريب", "ibsacademy.org", "IBS Training Academy"),
    ("Inbound Factor – SEO Company in Egypt", "inboundfactor.com", "Inbound Factor"),
    ("College Of Medicine - Nahrain University", "colmed-alnahrain.edu.iq",
     "College Of Medicine - Nahrain University"),       # part of the name: kept
    ("The American University of Iraq - Baghdad", "auib.edu.iq", "The American University of Iraq - Baghdad"),
    ("Amaq Al Iraq Company (PopularCert - ISO certification in Iraq)", "popularcert.com",
     "Amaq Al Iraq Company (PopularCert - ISO certification in Iraq)"),  # never inside brackets
    # ALL CAPS → title case; short acronyms stay.
    ("STS TRAINING CENTER", "stsoman.com", "STS Training Center"),
    ("HOLY QURAN ACADEMY IN SHARJAH", "holyquranshja.org", "Holy Quran Academy in Sharjah"),
    ("IDP IELTS BAHRAIN", "idp.com", "IDP Ielts Bahrain"),
    ("G-TEC COMPUTER EDUCATION BAHRAIN", "gtecbahrain.com", "G-TEC Computer Education Bahrain"),
    ("AMR ÖZEL GÜVENLİK EĞİTİM MERKEZİ", "amrguvenlikegitim.com", "AMR Özel Güvenlik Eğitim Merkezi"),
    ("İKPLUS EĞİTİM VE DANIŞMANLIK HİZMETLERİ", "ikplus.net", "İkplus Eğitim ve Danışmanlık Hizmetleri"),
    ("AEROPRAKT HAVACILIK A.Ş.", "aeroprakt.com.tr", "Aeroprakt Havacılık A.Ş."),
    ("İRİSPANEL PROFESSIONAL", "irispanel.com", "İrispanel Professional"),  # English word: dotted i
    # Left alone.
    ("ACAD", "acadegypt.com", "ACAD"),
    ("RECAP", "recapeg.com", "RECAP"),                 # a one-word brand
    ("TUV NORD", "tuv.com", "TUV NORD"),               # only short words
    ("abftc.az", "abftc.az", "abftc.az"),              # just a domain: nothing better to say
    ("Ershad - IDP IELTS IRAQ", "ieltsiraq.me", "Ershad - IDP IELTS IRAQ"),
    ("المركز الاميريكي اللبناني للغات والكومبيوتر ALLCC", "allcc.education",
     "المركز الاميريكي اللبناني للغات والكومبيوتر ALLCC"),
    ("Azerbaijan Academy of Labour and Social Affairs", "aesma.az", "Azerbaijan Academy of Labour and Social Affairs"),
])
def test_clean_name(raw, domain, want):
    clean, changed = clean_name(raw, domain)
    assert clean == want
    assert changed is (raw != want)
    assert clean_name(clean, domain) == (clean, False)   # idempotent


def test_clean_name_tidies_spaces_and_reports_it():
    assert clean_name("  Acme   Training ", "acme.com") == ("Acme Training", True)
    assert clean_name("", "acme.com") == ("", False)


# ---- categories -----------------------------------------------------------------------

def test_clean_category_one_spelling_per_label():
    assert clean_category("university") == clean_category("University") == "University"
    assert clean_category("  educational   institution ") == "Educational institution"
    assert clean_category("Training centre") == "Training center"         # synonym
    assert clean_category("nonprofit organization") == clean_category("Non-profit organization")
    assert clean_category("") == ""


def test_clean_category_follows_the_most_common_spelling():
    sp = category_spellings(["IT company", "IT company", "it company", "college"])
    assert clean_category("it company", sp) == "IT company"
    assert clean_category("COLLEGE", sp) == "College"


def test_clean_categories_drops_duplicates_any_case():
    assert clean_categories(["university", "University", "College", "college", " "]) == ["University", "College"]


# ---- websites ---------------------------------------------------------------------------

def test_site_root():
    assert site_root("https://51campus.org/rent-a-room/") == "https://51campus.org/"
    assert site_root("HTTP://WWW.Acme.COM:80/en/x?y=1#z") == "http://www.acme.com/"   # www kept as given
    assert site_root("https://acme.com:443") == "https://acme.com/"
    assert site_root("https://acme.com:8443/a") == "https://acme.com:8443/"
    assert site_root("acme.com/path") == "http://acme.com/"         # https isn't guessed
    assert site_root("//acme.com/x") == "http://acme.com/"
    assert site_root("") == ""
    assert site_root(site_root("http://Acme.com/a")) == "http://acme.com/"


def test_has_path():
    assert has_path("https://51campus.org/rent-a-room/") and has_path("http://a.com/?utm=1")
    assert not has_path("https://a.com/") and not has_path("https://a.com") and not has_path("a.com")


# ---- duplicates -------------------------------------------------------------------------

def test_domain_labels():
    assert domain_label("globalknowledge.com.eg") == domain_label("globalknowledge.com") == "globalknowledge"
    assert domain_label("aesma.edu.az") == domain_label("aesma.az") == "aesma"
    assert domain_label("en.pasteur.ac.ir") == "pasteur"
    assert labels_compatible("nkpi.az", "ameankpi.org")         # one inside the other
    assert not labels_compatible("ait.az", "aiet.eg")            # too short to be contained
    assert not labels_compatible("abc.az", "xabcx.com")


def test_core_name_drops_legal_forms():
    assert core_name("The Acme Group W.L.L.") == core_name("ACME") == "acme"
    assert core_name("Acme Trading Co. Ltd") == "acme trading"
    assert core_name("شركة عراقنا ذ.م.م") == fold("شركة عراقنا")
    assert core_name("Acme Company for Training") == "acme company for training"   # only at the end


def rec(id_, name, website=None):
    return {"id": id_, "name": name, "website": website or f"https://{id_}/"}


@pytest.mark.parametrize("a, b", [
    (rec("globalknowledge.com", "Global Knowledge"), rec("globalknowledge.com.eg", "Global Knowledge")),
    (rec("aesma.az", "Azerbaijan Academy of Labour and Social Affairs"),
     rec("aesma.edu.az", "AZERBAIJAN ACADEMY OF LABOUR AND SOCIAL AFFAIRS")),
    (rec("acme.ae", "Acme Training LLC"), rec("acme.com.sa", "ACME TRAINING")),
    (rec("nkpi.az", "Institute of Petrochemical Processes"), rec("ameankpi.org", "Institute of Petrochemical Processes")),
    (rec("mmc.az", "مؤسسة التدريب"), rec("mmc.com.eg", "موسسه التدريب")),              # Arabic variants
    (rec("a.example", "Alpha", "https://www.shared-site.example/a"),
     rec("b.example", "Beta", "http://shared-site.example/")),                        # the same site
])
def test_same_company_true(a, b):
    assert same_company(a, b) and same_company(b, a)


@pytest.mark.parametrize("a, b", [
    (rec("ilc.az", "International Learning Center"), rec("ilc.bh", "ILC Training")),       # names differ
    (rec("aiet.edu.eg", "Alexandria Higher Institute of Engineering and Technology"),
     rec("ait.edu.eg", "Alexandria Higher Institute of Engineering and Technology")),     # domains differ
    (rec("ut.ac.ir", "Institute of Geophysics"), rec("tehran.ac.ir", "Institute of Geophysics")),
    (rec("modern-academy.edu", "thebes academy"), rec("modern-academy.edu.eg", "Modern Academy")),
    (rec("a.example", "Alpha", "https://facebook.com/alpha"), rec("b.example", "Beta", "https://facebook.com/beta")),
    (rec("abc.az", "ABC"), rec("abc.com", "ABC")),                                         # too short a name
    (rec("abftc.az", "abftc.az"), rec("abftc.com", "abftc.az")),                            # a domain, not a name
])
def test_same_company_false(a, b):
    assert not same_company(a, b) and not same_company(b, a)
