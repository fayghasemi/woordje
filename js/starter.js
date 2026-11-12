// Optional starter packs for the Inburgering exam (A2 + KNM).
// Format: article|word|english|pos
const KNM = `
de|gemeente|municipality|noun
het|gemeentehuis|town hall|noun
de|burgemeester|mayor|noun
de|regering|government|noun
de|overheid|government, authorities|noun
de|minister|minister|noun
de|koning|king|noun
de|grondwet|constitution|noun
de|verkiezing|election|noun
|stemmen|to vote|verb
de|partij|(political) party|noun
de|Tweede Kamer|House of Representatives|noun
de|provincie|province|noun
de|belasting|tax|noun
de|Belastingdienst|Tax Administration|noun
de|toeslag|allowance, benefit|noun
de|zorgtoeslag|healthcare allowance|noun
de|huurtoeslag|rent allowance|noun
de|uitkering|benefit (payment)|noun
het|DigiD|digital ID for government services|noun
het|BSN|citizen service number|noun
de|verzekering|insurance|noun
de|zorgverzekering|health insurance|noun
het|eigen risico|deductible (health insurance)|noun
de|huisarts|GP, family doctor|noun
de|tandarts|dentist|noun
de|apotheek|pharmacy|noun
het|recept|prescription; recipe|noun
de|afspraak|appointment|noun
het|ziekenhuis|hospital|noun
de|spoedeisende hulp|emergency department|noun
de|verloskundige|midwife|noun
het|consultatiebureau|child health clinic|noun
de|basisschool|primary school|noun
de|middelbare school|secondary school|noun
de|leerplicht|compulsory education|noun
de|ouderavond|parents' evening|noun
het|diploma|diploma|noun
de|opleiding|education, training|noun
de|cursus|course|noun
het|werk|work|noun
de|baan|job|noun
de|werkgever|employer|noun
de|werknemer|employee|noun
het|contract|contract|noun
het|salaris|salary|noun
het|loon|wage|noun
de|vacature|job vacancy|noun
de|sollicitatie|job application|noun
|solliciteren|to apply (for a job)|verb
het|sollicitatiegesprek|job interview|noun
het|cv|CV, résumé|noun
de|vakantiedagen|vacation days|noun
het|vakantiegeld|holiday allowance|noun
|ziek melden|to call in sick|verb
de|vakbond|trade union|noun
het|UWV|Employee Insurance Agency|noun
de|huur|rent|noun
de|huurder|tenant|noun
de|verhuurder|landlord|noun
de|woningcorporatie|housing association|noun
de|buren|neighbours|noun
het|afval|waste, garbage|noun
de|vuilnisbak|rubbish bin|noun
de|energierekening|energy bill|noun
de|politie|police|noun
de|brandweer|fire brigade|noun
de|ambulance|ambulance|noun
de|wet|law|noun
de|rechter|judge|noun
de|discriminatie|discrimination|noun
de|gelijkheid|equality|noun
de|vrijheid|freedom|noun
de|godsdienst|religion|noun
de|vrijwilliger|volunteer|noun
de|bibliotheek|library|noun
het|openbaar vervoer|public transport|noun
de|OV-chipkaart|public transport card|noun
het|station|station|noun
de|trein|train|noun
de|bus|bus|noun
de|fiets|bicycle|noun
het|rijbewijs|driver's licence|noun
de|verjaardag|birthday|noun
de|Koningsdag|King's Day|noun
de|Bevrijdingsdag|Liberation Day|noun
de|Dodenherdenking|Remembrance of the Dead|noun
het|Sinterklaasfeest|Sinterklaas celebration|noun
de|gewoonte|habit, custom|noun
|op tijd|on time|phrase
|gezellig|cosy, pleasant|adjective
`;

const A2 = `
het|huis|house|noun
de|kamer|room|noun
de|keuken|kitchen|noun
de|tafel|table|noun
de|stoel|chair|noun
het|bed|bed|noun
de|deur|door|noun
het|raam|window|noun
de|sleutel|key|noun
het|boek|book|noun
de|krant|newspaper|noun
de|brief|letter|noun
het|formulier|form|noun
de|winkel|shop|noun
de|markt|market|noun
het|geld|money|noun
de|prijs|price|noun
de|rekening|bill, account|noun
het|brood|bread|noun
de|kaas|cheese|noun
de|melk|milk|noun
het|water|water|noun
de|koffie|coffee|noun
de|thee|tea|noun
het|vlees|meat|noun
de|groente|vegetable|noun
het|fruit|fruit|noun
de|appel|apple|noun
het|ei|egg|noun
de|man|man|noun
de|vrouw|woman, wife|noun
het|kind|child|noun
de|moeder|mother|noun
de|vader|father|noun
het|gezin|family (household)|noun
de|familie|family (relatives)|noun
de|vriend|friend|noun
de|dag|day|noun
de|week|week|noun
de|maand|month|noun
het|jaar|year|noun
het|uur|hour|noun
de|tijd|time|noun
het|weer|weather|noun
de|regen|rain|noun
de|zon|sun|noun
de|straat|street|noun
de|stad|city|noun
het|dorp|village|noun
het|land|country|noun
de|auto|car|noun
de|weg|road, way|noun
het|kantoor|office|noun
de|vraag|question|noun
het|antwoord|answer|noun
het|probleem|problem|noun
de|hulp|help|noun
het|lichaam|body|noun
het|hoofd|head|noun
de|hand|hand|noun
het|been|leg|noun
de|pijn|pain|noun
het|medicijn|medicine|noun
de|telefoon|telephone|noun
het|bericht|message|noun
de|computer|computer|noun
het|adres|address|noun
de|naam|name|noun
de|leeftijd|age|noun
het|feest|party|noun
het|cadeau|present, gift|noun
de|kleur|colour|noun
het|meisje|girl|noun
de|jongen|boy|noun
het|eten|food|noun
het|gesprek|conversation|noun
het|nieuws|news|noun
de|taal|language|noun
het|woord|word|noun
de|zin|sentence; desire|noun
het|kopje|cup|noun
het|glas|glass|noun
de|fles|bottle|noun
het|mes|knife|noun
de|vork|fork|noun
de|lepel|spoon|noun
het|bord|plate|noun
de|jas|coat|noun
de|schoen|shoe|noun
het|overhemd|shirt|noun
de|broek|trousers|noun
het|park|park|noun
de|zee|sea|noun
het|strand|beach|noun
de|boom|tree|noun
de|bloem|flower|noun
het|dier|animal|noun
de|hond|dog|noun
de|kat|cat|noun
`;

function parse(block, tag) {
  return block.trim().split('\n').map((l) => {
    const [article, word, en, pos] = l.split('|');
    return { article, word, en, pos, tag };
  });
}

export const PACKS = {
  knm: { title: 'KNM essentials', subtitle: 'Kennis van de Nederlandse Maatschappij: government, health, work, housing', items: parse(KNM, 'KNM') },
  a2: { title: 'A2 everyday nouns', subtitle: 'Common nouns every A2 learner needs, with de/het', items: parse(A2, 'A2') },
};

// Nouns used by the de/het trainer when you don't have enough of your own yet.
export const BUILTIN_NOUNS = [...PACKS.a2.items, ...PACKS.knm.items]
  .filter((x) => x.pos === 'noun' && (x.article === 'de' || x.article === 'het') && !/\s/.test(x.word) && x.word[0] === x.word[0].toLowerCase())
  .filter((x, i, arr) => arr.findIndex((y) => y.word === x.word) === i);
