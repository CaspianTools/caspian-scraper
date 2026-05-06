#!/usr/bin/env python3
"""
One-shot cleanup: DELETE the non-HSE vacancies that the first scraper run
posted to entirelysafe.com before the title-only filter was in place.

Run once with ENTIRELYSAFE_API_KEY set, then this file can be removed.
"""

from __future__ import annotations

import os
import sys

import requests


API_BASE = "https://entirelysafe.com/api/v1"

# Each entry is (vacancy_id, title) — title kept for audit only.
# IDs come from the `published_roles` array of the first run's JSON summary.
TARGETS: list[tuple[str, str]] = [
    ("hrRB0jUbXA26J8HAseHc", "Well Site Supvervisor, I"),
    ("qaCQnhL5CFdxsdTug4zz", "Service Leader (Completion Tools)"),
    ("0ldgvVr1EV1B1Qy6Mwr7", "Service Leader-Frac Acid"),
    ("wI9gEWkFoCF2veJBpPTh", "Service Leader (Coiled Tubing)"),
    ("aC8AMLHG41Nufl55fXPa", "Service Leader - District PSL Service Manager (Frac Acid)"),
    ("hGBQLfzkNBxWhvBvl4dW", "Internship Program"),
    ("9Ehy3mS5siTJFfu7Jw6m", "QA/QC Coordinator"),
    ("h71lRCCVBcS4SZcJ7xpn", "Suriname - Paramaribo: Chemical Scientist, Cementing"),
    ("omXB307qKcswBA8lrVwp", "Argentina - Neuquen - Senior Transportation & Logistics Specialist"),
    ("i4z1OZHclpHpCZCsmalp", "Guyana - Georgetown: Chemical Scientist - Baroid"),
    ("xnDBKRvyWrL36CLNLORO", "Argentina Neuquen: Supervisor de Almacen-Supply Chain"),
    ("gy9GspRDnT51CmoauT5O", "Operator Assistant I - Logging & Perforating"),
    ("hI7H89pul2ns2R8jKoY1", "Brasil - Bahia - Catu: Especialista de Canhoneio JR - WP"),
    ("YCUXhi3UWl7PAz5jxXdz", "Operator Assistant I-Service Operator I (Logging & Perforating)"),
    ("2uoUsKW61AEgGL1ILqUy", "Plant Specialist - Baroid Mine"),
    ("pOQEJRX0B3fuYKsKGJN0", "Colombia - Meta - Villavicencio - Technical Sales Advisor"),
    ("XFPd0VGbrobMxfpw4Chh", "R&D Electronics Engineer Sperry Drilling"),
    ("3Gizm0GP48tknXNxwiRD", "Operator Assistant II - Wireline Logging & Perforating"),
]


def main() -> int:
    api_key = os.environ.get("ENTIRELYSAFE_API_KEY", "").strip()
    if not api_key:
        print("ENTIRELYSAFE_API_KEY is not set", file=sys.stderr)
        return 1

    session = requests.Session()
    session.headers.update({
        "X-API-Key": api_key,
        "Accept": "application/json",
    })

    deleted = 0
    not_found = 0
    failed = 0

    for vacancy_id, label in TARGETS:
        try:
            r = session.delete(
                f"{API_BASE}/vacancies/{vacancy_id}", timeout=30,
            )
        except requests.RequestException as e:
            print(f"ERR  {vacancy_id}  network  {label}  ({e})")
            failed += 1
            continue

        if r.status_code in (200, 204):
            print(f"OK   {vacancy_id}  {r.status_code}  {label}")
            deleted += 1
        elif r.status_code == 404:
            print(f"SKIP {vacancy_id}  404      {label}  (already gone)")
            not_found += 1
        else:
            body = (r.text or "")[:200]
            print(f"ERR  {vacancy_id}  {r.status_code}      {label}  {body}")
            failed += 1

    print(f"\ndeleted={deleted} not_found={not_found} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
