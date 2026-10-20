// Country names offered by <CountrySelect>. Common English short names; the
// value stored is the name itself (resources keep `countries: string[]`).
// aiconfig/discover.py maps aliases ("UAE" ↔ "United Arab Emirates", …) when
// matching, so older free-text values keep working.

export const COUNTRIES: readonly string[] = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda",
  "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain",
  "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
  "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria",
  "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde",
  "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros",
  "Congo", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czechia",
  "Democratic Republic of the Congo", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea",
  "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon",
  "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea",
  "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland",
  "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica",
  "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait",
  "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya",
  "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia",
  "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico",
  "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique",
  "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua",
  "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan",
  "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru",
  "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa",
  "San Marino", "São Tomé and Príncipe", "Saudi Arabia", "Senegal", "Serbia",
  "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands",
  "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka",
  "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan",
  "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago",
  "Tunisia", "Türkiye", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine",
  "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan",
  "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe",
];

/** One-click groups at the top of the list; picking one adds every member. */
export const COUNTRY_GROUPS: readonly { label: string; countries: readonly string[] }[] = [
  {
    label: "GCC (Gulf states)",
    countries: ["Bahrain", "Kuwait", "Oman", "Qatar", "Saudi Arabia", "United Arab Emirates"],
  },
  {
    label: "Middle East",
    countries: [
      "Bahrain", "Egypt", "Iran", "Iraq", "Jordan", "Kuwait", "Lebanon", "Oman",
      "Palestine", "Qatar", "Saudi Arabia", "Syria", "United Arab Emirates", "Yemen",
    ],
  },
];

// Extra words a search should match, so typing "UAE" or "KSA" finds the entry.
export const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "United Arab Emirates": ["uae", "emirates", "dubai", "abu dhabi"],
  "Saudi Arabia": ["ksa"],
  "United Kingdom": ["uk", "britain", "great britain", "england"],
  "United States": ["usa", "us", "america"],
  Türkiye: ["turkey", "turkiye"],
  Czechia: ["czech republic"],
  "Côte d'Ivoire": ["ivory coast", "cote d'ivoire"],
  "South Korea": ["korea"],
  Eswatini: ["swaziland"],
  Myanmar: ["burma"],
};
