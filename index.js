import discord from 'discord.js';
import { config } from 'dotenv';
import express from 'express';
import keepAlive from './server.js';
import { Generations, Pokemon, Move, calculate, Field } from '@smogon/calc';
import fetch from 'node-fetch';

config();

const app = express();
const bot = new discord.Client({ intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildMessages, discord.GatewayIntentBits.MessageContent] });

const setsCache = new Map();
console.log("Bot starting...");

bot.once('ready', () => {
  console.log(`Logged in as ${bot.user.tag}`);
});

function statMap(stat) {
  return {
    hp: 'hp',
    atk: 'atk',
    def: 'def',
    spa: 'spa',
    spd: 'spd',
    spe: 'spe'
  }[stat.toLowerCase()];
}

function detectNatureFromEVs(str) {
  const regex = new RegExp('(\\d+)\\s*([+\\-])\\s*(HP|Atk|Def|SpA|SpD|Spe)', 'gi');
  const matches = [...str.matchAll(regex)];
  let plus = null, minus = null;

  for (const [, , sign, stat] of matches) {
    const mapped = statMap(stat);
    if (sign === '+') {
      plus = mapped;
    } else if (sign === '-') {
      minus = mapped;
    }
  }

  // If we have a + nature but no explicit - nature, we need to infer the - stat
  if (plus && !minus) {
    // Common nature patterns for damage calculation
    const commonMinusStats = {
      'atk': 'spa',  // Physical attackers often drop SpA
      'spa': 'atk',  // Special attackers often drop Atk
      'spe': 'atk',  // Speed boosters often drop Atk
      'def': 'spa',  // Defensive mons often drop SpA
      'spd': 'atk'  // Special defensive mons often drop Atk
    };
    minus = commonMinusStats[plus] || 'atk'; // Default to dropping Atk
  }

  return plus && minus ? getNatureName(plus, minus) : null;
}

function getNatureName(plus, minus) {
  const natureMap = {
    'atk-def': 'Lonely',
    'atk-spa': 'Adamant',
    'atk-spd': 'Naughty',
    'atk-spe': 'Brave',
    'def-atk': 'Bold',
    'def-spa': 'Impish',
    'def-spd': 'Lax',
    'def-spe': 'Relaxed',
    'spa-atk': 'Modest',
    'spa-def': 'Mild',
    'spa-spd': 'Rash',
    'spa-spe': 'Quiet',
    'spd-atk': 'Calm',
    'spd-def': 'Gentle',
    'spd-spa': 'Careful',
    'spd-spe': 'Sassy',
    'spe-atk': 'Timid',
    'spe-def': 'Hasty',
    'spe-spa': 'Jolly',
    'spe-spd': 'Naive'
  };

  const key = `${plus}-${minus}`;
  return natureMap[key] || 'Hardy'; // Default to Hardy (neutral nature)
}

function parseField(rawInput) {
  const weatherMatch = rawInput.match(/\b(?:in)\s+(Rain|Sun|Sand|Hail|Snow)/i);
  const terrainMatch = rawInput.match(/\b(?:on|with)\s+(Electric|Grassy|Psychic|Misty)\s+Terrain/i);
  const screensMatch = rawInput.match(/\b(?:under|with)\s+(Light Screen|Reflect|Aurora Veil)/i);
  const srMatch = rawInput.match(/\b(?:after|with)\s+Stealth Rock/i);
  const spikesMatch = rawInput.match(/(?:with\s+)?(\d+)\s+layers?\s+of\s+Spikes/i);
  const gravityMatch = rawInput.match(/\b(?:under|with)\s+Gravity/i);

  return {
    weather: weatherMatch ? weatherMatch[1] : undefined,
    terrain: terrainMatch ? terrainMatch[1] : undefined,
    isGravity: !!gravityMatch,
    defenderSide: {
      isLightScreen: screensMatch?.[1] === 'Light Screen',
      isReflect: screensMatch?.[1] === 'Reflect',
      isAuroraVeil: screensMatch?.[1] === 'Aurora Veil',
      isSR: !!srMatch,
      spikes: spikesMatch ? parseInt(spikesMatch[1], 10) : 0
    }
  }
}

function parseCalcInput(rawInput) {
  // First, extract field data and get a cleaned input string for Pokémon/move parsing
  const fieldData = parseField(rawInput);

  let cleanedInputForPokemon = rawInput
    // Remove weather
    .replace(/\b(?:in|under)\s+(Rain|Sun|Sand|Hail|Snow)/gi, '')
    // Remove terrain
    .replace(/\b(?:on|with)\s+(Electric|Grassy|Psychic|Misty)\s+Terrain/gi, '')
    // Remove screens
    .replace(/\b(?:under|with)\s+(Light Screen|Reflect|Aurora Veil)/gi, '')
    // Remove Stealth Rock
    .replace(/\b(?:after|with)\s+Stealth Rock/gi, '')
    // Remove Spikes
    .replace(/\b(?:and\s+)?(?:with\s+)?(?:\d+\s+)?layers?\s+of\s+Spikes/gi, '')
    // Remove Gravity
    .replace(/\b(?:under|with)\s+Gravity/gi, '')
    .trim();

  const match = cleanedInputForPokemon.match(/(.+?) using (.+?) vs (.+)/i);
  if (!match) return null;

  const [, attackerStr, move, defenderStr] = match;

  function parseSide(str) {
    const evs = {}, boosts = {}, natureHints = {};

    // Parse nature from + and - indicators
    const natureData = detectNatureFromEVs(str);

    // Parse ability from parentheses
    const abilityMatch = str.match(/\(([^)]+)\)/);
    const ability = abilityMatch ? abilityMatch[1].trim() : null;

    // Parse EVs and boosts
    const evMatches = [...str.matchAll(/([+-]\d+)?\s*(\d+)?([+-]?)\s*(HP|Atk|Def|SpA|SpD|Spe)/gi)];
    for (const [, boostPart, rawEV, evSign, stat] of evMatches) {
      const mappedStat = statMap(stat);

      // Handle boost like "+2" or "-1"
      if (boostPart) {
        boosts[mappedStat] = parseInt(boostPart);
      }

      // Handle EVs (like "252" or "252+")
      if (rawEV) {
        evs[mappedStat] = parseInt(rawEV);

        // Handle nature indicator (e.g., 252+ means increased nature)
        if (evSign === '+' || evSign === '-') {
          natureHints[mappedStat] = evSign;
        }
      }
    }

    // Clean the string
    const cleaned = str
      .replace(/([+-]\d+)?\s*\d*[+-]?\s*(HP|Atk|Def|SpA|SpD|Spe)(?:\s*\/\s*)?/gi, '')
      .replace(/\([^)]+\)/g, '') // remove ability
      .replace(/\s+/g, ' ')
      .trim();

    const [name, item] = cleaned.split('@').map(s => s.trim());

    return {
      name,
      item: item || '',
      evs,
      boosts,
      nature: natureData,
      ability
    };
  }

  // Example usage (probably inside parseCalcInput)
  return {
    attacker: parseSide(attackerStr),
    move: move.trim(),
    defender: parseSide(defenderStr),
    fieldData: fieldData
  };
}


// Function to fetch sets data from Smogon API
async function fetchSetsData(format) {
  const cacheKey = format;

  if (setsCache.has(cacheKey)) {
    return setsCache.get(cacheKey);
  }

  try {
    const url = `https://pkmn.github.io/smogon/data/sets/${format}.json`;
    console.log(`Fetching sets from: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    setsCache.set(cacheKey, data);

    // Cache for 30 minutes
    setTimeout(() => {
      setsCache.delete(cacheKey);
    }, 30 * 60 * 1000);

    return data;
  } catch (error) {
    console.error(`Error fetching sets for ${format}:`, error);
    throw error;
  }
}

function getSmogonGenCode(gen) {
  const genMap = {
    9: 'sv',
    8: 'ss',
    7: 'sm',
    6: 'xy',
    5: 'bw',
    4: 'dp',
    3: 'rs',
    2: 'gs',
    1: 'rb'
  };
  return genMap[gen] || 'sv'; // default to SV if unknown
}

function formatSpeciesForUrl(species) {
  return species.toLowerCase().replace(/\s/g, '-').replace(/['']/g, '');
}

function buildSmogonUrl(species, format) {
  const match = format.match(/^gen(\d)([a-z0-9]+)$/i);
  if (!match) return null;

  const genNum = parseInt(match[1], 10);
  const tier = match[2].toLowerCase(); // e.g. 'ou'
  const genCode = getSmogonGenCode(genNum);
  const speciesSlug = formatSpeciesForUrl(species);

  return `https://www.smogon.com/dex/${genCode}/pokemon/${speciesSlug}/${tier}/`;
}

// Function to search for Pokemon sets
function findPokemonSets(setsData, pokemonName) {
  // Normalize the Pokemon name for searching
  const normalizedSearch = pokemonName.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const [speciesName, sets] of Object.entries(setsData)) {
    const normalizedSpecies = speciesName.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normalizedSpecies === normalizedSearch ||
        normalizedSpecies.includes(normalizedSearch) ||
        normalizedSearch.includes(normalizedSpecies)) {
      return { species: speciesName, sets };
    }
  }

  return null;
}

// Function to format a moveset for display
function formatMoveset(species, setName, setData) {
  let formatted = `\`\`\`${species}`;
  if (setData.item) formatted += ` @ ${setData.item}\n`;
  if (setData.ability) formatted += `Ability: ${setData.ability}\n`;
  if (setData.evs) {
    const evStr = Object.entries(setData.evs)
      .filter(([, value]) => value > 0)
      .map(([stat, value]) => `${value} ${stat.toUpperCase()}`)
      .join(' / ');
    if (evStr) formatted += `EVs: ${evStr}\n`;
  }
  if (setData.nature) formatted += `${setData.nature} Nature\n`;

  if (setData.ivs) {
    const ivStr = Object.entries(setData.ivs)
      .filter(([, value]) => value < 31)
      .map(([stat, value]) => `${value} ${stat.toUpperCase()}`)
      .join(' / ');
    if (ivStr) formatted += `IVs: ${ivStr}\n`;
  }

  if (setData.moves && setData.moves.length > 0) {
    formatted += `- ${setData.moves.join('\n- ')}\n`;
  }  
  formatted += `\`\`\``;
  return formatted;
}

// Message handler
bot.on('messageCreate', async message => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // Handle the 'cat calc' command
  if (content.startsWith('!cat calc ')) {
    const inputStr = content.slice('!cat calc '.length);
    const parsed = parseCalcInput(inputStr);
    if (!parsed) {
      return message.channel.send('Could not parse input. Use `!cat calc <attacker> using <move> vs <target> [in Rain/on Grassy Terrain/with Stealth Rock/with Light Screen/with 1 layer of Spikes/under Gravity]` format.');
    }

    // debugging
    console.log('Parsed Attacker:', parsed.attacker.name);
    console.log('Parsed Attacker Nature:', parsed.attacker.nature);
    console.log('Parsed Attacker Ability:', parsed.attacker.ability);
    console.log('Parsed Defender:', parsed.defender.name);
    console.log('Parsed Defender Nature:', parsed.defender.nature);
    console.log('Parsed Defender Ability:', parsed.defender.ability);
    console.log('Parsed Move:', parsed.move);
    console.log('Parsed Field Data:', parsed.fieldData);

    const { attacker, defender, move, fieldData } = parsed;
    const {
            weather,
            terrain,
            isGravity,
            defenderSide: {
              isLightScreen,
              isReflect,
              isAuroraVeil,
              isSR,
              spikes
            }
    } = fieldData;

    const gen = Generations.get(9);
    const field = new Field({
                  weather,
                  terrain,
                  isGravity,
                  defenderSide: {
                    isLightScreen,
                    isReflect,
                    isAuroraVeil,
                    isSR,
                    spikes
                  }
                });
    try {
      var atk = new Pokemon(gen, attacker.name, {
        item: attacker.item || undefined,
        ability: attacker.ability || undefined,
        evs: attacker.evs,
        boosts: attacker.boosts,
        nature: attacker.nature || undefined
      });
      var def = new Pokemon(gen, defender.name, {
        item: defender.item || undefined,
        ability: defender.ability || undefined,
        evs: defender.evs,
        boosts: defender.boosts,
        nature: defender.nature || undefined
      });
      var mv = new Move(gen, move);
    } catch (e) {
      return message.channel.send(`Error parsing Pokémon or move: ${e.message}`);
    }

    const result = calculate(gen, atk, def, mv, field);
    await message.channel.send(result.desc());
  }
  // Handle the 'cat sets' command
  else if (content.startsWith('!cat sets ')) {
    const inputStr = content.slice('!cat sets '.length).trim();
    const parts = inputStr.split(' ');

    // Default format is gen9ou, but allow users to specify format
    let format = 'gen9ou';
    let pokemonName = inputStr;

    // Check if first part looks like a format 
    if (parts.length > 1 && parts[0].match(/^gen\d+[a-z]+$/i)) {
      format = parts[0].toLowerCase();
      pokemonName = parts.slice(1).join(' ');
    }

    if (!pokemonName) {
      return message.channel.send('Please specify a Pokémon name. Usage: `!cat sets <pokemon>` or `!cat sets <format> <pokemon>`');
    }

    try {
      const setsData = await fetchSetsData(format);
      const pokemonSets = findPokemonSets(setsData, pokemonName);

      if (!pokemonSets) {
        return message.channel.send(`No sets found for "${pokemonName}" in ${format}. Try a different format or check the spelling.`);
      }

      const { species, sets } = pokemonSets;
      const setNames = Object.keys(sets);

      if (setNames.length === 0) {
        return message.channel.send(`No sets available for ${species} in ${format}.`);
      }

      // Show all sets regardless of count
      const smogonUrl = buildSmogonUrl(species, format);
      let response = `**${species}** sets in **${format}**:\n\n[Smogon Analysis](${smogonUrl})\n\n`;

      for (const [setName, setData] of Object.entries(sets)) {
        response += formatMoveset(species, setName, setData) + '\n';
        // Discord has a 2000 character limit
        if (response.length > 1800) {
          await message.channel.send(response);
          response = '';
        }
      }

      if (response.trim()) {
        await message.channel.send(response);
      }

    } catch (error) {
      console.error('Error fetching sets:', error);
      await message.channel.send(`Error fetching sets for ${format}: ${error.message}`);
    }
  }

  // Handle the 'cat set' command (for specific set)
  else if (content.startsWith('!cat set ')) {
    const inputStr = content.slice('!cat set '.length).trim();
    const parts = inputStr.split(' ');

    if (parts.length < 3) {
      return message.channel.send('Usage: `!cat set <format> <pokemon> <set name>`');
    }

    const format = parts[0].toLowerCase();
    const pokemonName = parts[1];
    const setName = parts.slice(2).join(' ');

    try {
      const setsData = await fetchSetsData(format);
      const pokemonSets = findPokemonSets(setsData, pokemonName);

      if (!pokemonSets) {
        return message.channel.send(`No sets found for "${pokemonName}" in ${format}.`);
      }

      const { species, sets } = pokemonSets;

      // Find the specific set (case-insensitive)
      const matchingSetName = Object.keys(sets).find(name =>
        name.toLowerCase() === setName.toLowerCase()
      );

      if (!matchingSetName) {
        const availableSets = Object.keys(sets).join(', ');
        return message.channel.send(`Set "${setName}" not found for ${species}. Available sets: ${availableSets}`);
      }

      const setData = sets[matchingSetName];
      const smogonUrl = buildSmogonUrl(species, format);
      const response = `**${species}** in **${format}**:\n[Smogon Analysis](${smogonUrl})\n\n${formatMoveset(species, matchingSetName, setData)}`;
      await message.channel.send(response);

    } catch (error) {
      console.error('Error fetching specific set:', error);
      await message.channel.send(`Error fetching set: ${error.message}`);
    }
  }

  // Handle the 'cat' command
  else if (content === '!cat') {
    try {
      const res = await fetch('https://api.thecatapi.com/v1/images/search');
      const data = await res.json();
      if (data && data.length > 0 && data[0].url) {
        await message.channel.send(data[0].url);
      } else {
        await message.channel.send('😿 Could not find a cat image at the moment.');
      }
    } catch (e) {
      await message.channel.send('😿 Failed to fetch a cat. Something went wrong with the API request.');
      console.error('Error fetching cat:', e);
    }
  }

  else if (content.toLowerCase().startsWith('!cat stats')) {
    const args = content.split(' ').slice(2); // Everything after '!cat stats'
    const pokemonName = args.join('-').toLowerCase(); // Join with hyphens for PokéAPI format

    if (!pokemonName) {
      await message.channel.send('Please provide a Pokémon name. Usage: `!cat stats chien-pao`');
      return;
    }
    if (pokemonName.includes('Flutter Mane')) {
      const response = '😿 Flutter Mane is evil meow, cant you check a different mon instead?';
    }
    else{
      const response = '';
    }

    try {
      const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
      if (!res.ok) {
        throw new Error('Pokémon not found');
      }

      const data = await res.json();

      // Extract base stats
      const stats = data.stats.map(stat => `${stat.stat.name}: ${stat.base_stat}`).join('\n');

      // Extract abilities
      const abilities = data.abilities.map(ability => ability.ability.name).join(', ');

      // Image (official artwork or fallback sprite)
      const image = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;

      response += `**Stats for ${data.name.charAt(0).toUpperCase() + data.name.slice(1)}**
**Abilities:** ${abilities}
**Base Stats:**\n${stats}`;

      await message.channel.send({ content: response, files: [image] });

    } catch (e) {
      await message.channel.send(`😿 Could not find stats for "${pokemonName.replace(/-/g, ' ')}". Does this meown exist?`);
      console.error('Error fetching Pokémon data:', e);
    }
  }


  // Handle help command
  else if (content === '!cat help') {
    const helpMessage = `**Cat Bot Commands:**
\`!cat\` - Get a random cat image
\`!cat calc <attacker> using <move> vs <defender>\` - Calculate damage
  - Field conditions: \`in Rain/Sun/Sand/Hail/Snow\`
  - Terrain: \`on Electric/Grassy/Psychic/Misty Terrain\`
  - Screens: \`with Light Screen/Reflect/Aurora Veil\`
  - Hazards: \`with Stealth Rock\`, \`with 1 layer of Spikes\`
  - Other: \`under Gravity\`
\`!cat sets <pokemon>\` - Get sets for a Pokemon (default: gen9ou)
\`!cat sets <format> <pokemon>\` - Get sets for a Pokemon in specific format
\`!cat set <format> <pokemon> <set name>\` - Get a specific set
\`!cat help\` - Show this help message

**Example:** \`!cat calc 252+ Atk Garchomp @ Choice Band using Earthquake vs 252 HP / 4 Def Toxapex in Sand with Stealth Rock\``;
    await message.channel.send(helpMessage);
  }
});

keepAlive();
bot.login(process.env.DISCORD_TOKEN);