<?php declare(strict_types = 0);

namespace Modules\SlaDashboard\Includes;

use CAbsoluteTimeParser;
use CParser;
use CProfile;
use CTimezoneHelper;
use DateTimeZone;

/**
 * Filtro da página Services → SLA dashboard. Mesmos campos das telas do Zabbix (SLA e Service do SLA
 * report, Tags do Services, Host groups/Hosts do Problems, From/To do SLA report) mais o agrupamento
 * por hora, dia, semana, mês ou ano. Fica no perfil do usuário (CProfile), como nas telas do core.
 */
class CSlaFilter {

	public const PROFILE = 'web.sladashboard.filter';

	public const PERIOD_HOUR = 0;
	public const PERIOD_DAY = 1;
	public const PERIOD_WEEK = 2;
	public const PERIOD_MONTH = 3;
	public const PERIOD_YEAR = 4;

	/** Intervalo padrão (sem From/To) para cada agrupamento. */
	private const DEFAULT_RANGE = [
		self::PERIOD_HOUR => 'P1D',
		self::PERIOD_DAY => 'P30D',
		self::PERIOD_WEEK => 'P12W',
		self::PERIOD_MONTH => 'P12M',
		self::PERIOD_YEAR => 'P5Y'
	];

	/** Regras para o validador clássico do CController (as mesmas do SLA report/Problems). */
	public static function rules(): array {
		return [
			'filter_slaids' =>		'array_id',
			'filter_serviceids' =>	'array_id',
			'filter_groupids' =>	'array_id',
			'filter_hostids' =>		'array_id',
			'filter_evaltype' =>	'in '.TAG_EVAL_TYPE_AND_OR.','.TAG_EVAL_TYPE_OR,
			'filter_tags' =>		'array',
			'filter_period' =>		'in '.implode(',', array_keys(self::DEFAULT_RANGE)),
			'filter_date_from' =>	'string',
			'filter_date_to' =>		'string',
			'filter_set' =>			'in 1',
			'filter_rst' =>			'in 1'
		];
	}

	public static function save(array $input): void {
		foreach (['slaids', 'serviceids', 'groupids', 'hostids'] as $field) {
			CProfile::updateArray(self::PROFILE.'.'.$field, $input['filter_'.$field] ?? [], PROFILE_TYPE_ID);
		}
		CProfile::update(self::PROFILE.'.evaltype', $input['filter_evaltype'] ?? TAG_EVAL_TYPE_AND_OR,
			PROFILE_TYPE_INT
		);
		CProfile::update(self::PROFILE.'.period', $input['filter_period'] ?? self::PERIOD_DAY, PROFILE_TYPE_INT);
		CProfile::update(self::PROFILE.'.date_from', $input['filter_date_from'] ?? '', PROFILE_TYPE_STR);
		CProfile::update(self::PROFILE.'.date_to', $input['filter_date_to'] ?? '', PROFILE_TYPE_STR);

		$tags = ['tag' => [], 'value' => [], 'operator' => []];
		foreach ($input['filter_tags'] ?? [] as $tag) {
			if (!is_array($tag) || !array_key_exists('tag', $tag) || ($tag['tag'] === '' && ($tag['value'] ?? '') === '')) {
				continue;
			}
			$tags['tag'][] = (string) $tag['tag'];
			$tags['value'][] = (string) ($tag['value'] ?? '');
			$tags['operator'][] = (int) ($tag['operator'] ?? TAG_OPERATOR_LIKE);
		}
		CProfile::updateArray(self::PROFILE.'.tags.tag', $tags['tag'], PROFILE_TYPE_STR);
		CProfile::updateArray(self::PROFILE.'.tags.value', $tags['value'], PROFILE_TYPE_STR);
		CProfile::updateArray(self::PROFILE.'.tags.operator', $tags['operator'], PROFILE_TYPE_INT);
	}

	public static function reset(): void {
		foreach (['slaids', 'serviceids', 'groupids', 'hostids', 'tags.tag', 'tags.value', 'tags.operator'] as $f) {
			CProfile::deleteIdx(self::PROFILE.'.'.$f);
		}
		foreach (['evaltype', 'period', 'date_from', 'date_to'] as $f) {
			CProfile::delete(self::PROFILE.'.'.$f);
		}
	}

	public static function load(): array {
		$tags = [];
		$tag_names = CProfile::getArray(self::PROFILE.'.tags.tag', []);
		$values = CProfile::getArray(self::PROFILE.'.tags.value', []);
		$operators = CProfile::getArray(self::PROFILE.'.tags.operator', []);
		foreach ($tag_names as $i => $tag) {
			$tags[] = [
				'tag' => $tag,
				'value' => $values[$i] ?? '',
				'operator' => (int) ($operators[$i] ?? TAG_OPERATOR_LIKE)
			];
		}

		return [
			'slaids' => CProfile::getArray(self::PROFILE.'.slaids', []),
			'serviceids' => CProfile::getArray(self::PROFILE.'.serviceids', []),
			'groupids' => CProfile::getArray(self::PROFILE.'.groupids', []),
			'hostids' => CProfile::getArray(self::PROFILE.'.hostids', []),
			'evaltype' => (int) CProfile::get(self::PROFILE.'.evaltype', TAG_EVAL_TYPE_AND_OR),
			'tags' => $tags,
			'period' => (int) CProfile::get(self::PROFILE.'.period', self::PERIOD_DAY),
			'date_from' => CProfile::get(self::PROFILE.'.date_from', ''),
			'date_to' => CProfile::get(self::PROFILE.'.date_to', '')
		];
	}

	/** Filtro "mexido" (para o contador do botão Filter, como nas telas do core). */
	public static function countActive(array $filter): int {
		$n = 0;
		foreach (['slaids', 'serviceids', 'groupids', 'hostids', 'tags'] as $f) {
			$n += $filter[$f] ? 1 : 0;
		}
		$n += $filter['date_from'] !== '' || $filter['date_to'] !== '' ? 1 : 0;

		return $n;
	}

	/**
	 * Converte From/To (YYYY-MM-DD, como no SLA report) em timestamps, no fuso dado. Sem datas, usa o
	 * intervalo padrão do agrupamento terminando agora. Devolve [from, to, erros].
	 */
	public static function getRange(array $filter, DateTimeZone $timezone): array {
		$errors = [];
		$parser = new CAbsoluteTimeParser();
		$from = null;
		$to = null;

		foreach (['date_from' => _('From'), 'date_to' => _('To')] as $field => $label) {
			if ($filter[$field] === '') {
				continue;
			}
			if ($parser->parse($filter[$field]) == CParser::PARSE_SUCCESS) {
				$ts = $parser->getDateTime($field === 'date_from', $timezone)->getTimestamp();
				if ($ts < 0 || $ts > ZBX_MAX_DATE) {
					$errors[] = _s('Incorrect value for field "%1$s": %2$s.', $label, _('a date is expected'));
				}
				elseif ($field === 'date_from') {
					$from = $ts;
				}
				else {
					$to = $ts + 1;
				}
			}
			else {
				$errors[] = _s('Incorrect value for field "%1$s": %2$s.', $label, _('a date is expected'));
			}
		}

		if ($from !== null && $to !== null && $to <= $from) {
			$errors[] = _s('"%1$s" date must be less than "%2$s" date.', _('From'), _('To'));
			$from = null;
			$to = null;
		}

		$now = time();
		if ($to === null) {
			$to = $now;
		}
		if ($from === null) {
			$from = (new \DateTime('@'.$to))
				->setTimezone($timezone)
				->sub(new \DateInterval(self::DEFAULT_RANGE[$filter['period']]))
				->getTimestamp();
		}

		return [$from, min($to, $now), $errors];
	}

	public static function systemTimezone(): DateTimeZone {
		return new DateTimeZone(CTimezoneHelper::getSystemTimezone());
	}
}
