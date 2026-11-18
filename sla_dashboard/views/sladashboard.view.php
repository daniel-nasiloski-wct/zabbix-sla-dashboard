<?php
/**
 * Página Services → SLA dashboard. O filtro usa os mesmos componentes do core (CMultiSelect do SLA
 * report e do Problems, CTagFilterFieldHelper do Services, CDateSelector do SLA report); os gráficos
 * são desenhados pelo assets/js/sla-dashboard.js a partir do bootstrap.
 *
 * @var CView $this
 * @var array $data
 */

use Modules\SlaDashboard\Includes\CI18n;
use Modules\SlaDashboard\Includes\CSlaFilter;

$assets = $this->getAssetsPath();
$built = (@filemtime(__DIR__.'/../assets/js/sla-dashboard.js') ?: 0) + (@filemtime(__DIR__.'/../assets/css/sla-dashboard.css') ?: 0);
$version = rawurlencode($data['version'].'-'.$built);

$this->addCssFile($assets.'/css/sla-dashboard.css?v='.$version);
$this->enableLayoutModes();
$web_layout_mode = $this->getLayoutMode();
$this->addJsFile('layout.mode.js');

$filter = $data['filter'];

$left = (new CFormGrid())
	->addClass(CFormGrid::ZBX_STYLE_FORM_GRID_LABEL_WIDTH_TRUE)
	->addItem([
		new CLabel(_('SLA'), 'filter_slaids__ms'),
		new CFormField(
			(new CMultiSelect([
				'name' => 'filter_slaids[]',
				'object_name' => 'sla',
				'data' => $data['ms']['slas'],
				'multiple' => true,
				'popup' => [
					'parameters' => [
						'srctbl' => 'sla',
						'srcfld1' => 'slaid',
						'dstfrm' => CFilter::FORM_NAME,
						'dstfld1' => 'filter_slaids_',
						'enabled_only' => 1
					]
				]
			]))->setWidth(ZBX_TEXTAREA_FILTER_STANDARD_WIDTH)
		)
	])
	->addItem([
		new CLabel(_('Service'), 'filter_serviceids__ms'),
		new CFormField(
			(new CMultiSelect([
				'name' => 'filter_serviceids[]',
				'object_name' => 'services',
				'data' => $data['ms']['services'],
				'multiple' => true,
				'custom_select' => true
			]))->setWidth(ZBX_TEXTAREA_FILTER_STANDARD_WIDTH)
		)
	])
	->addItem([
		new CLabel(_('Host groups'), 'filter_groupids__ms'),
		new CFormField(
			(new CMultiSelect([
				'name' => 'filter_groupids[]',
				'object_name' => 'hostGroup',
				'data' => $data['ms']['groups'],
				'multiple' => true,
				'popup' => [
					'parameters' => [
						'srctbl' => 'host_groups',
						'srcfld1' => 'groupid',
						'dstfrm' => CFilter::FORM_NAME,
						'dstfld1' => 'filter_groupids_',
						'enrich_parent_groups' => true
					]
				]
			]))->setWidth(ZBX_TEXTAREA_FILTER_STANDARD_WIDTH)
		)
	])
	->addItem([
		new CLabel(_('Hosts'), 'filter_hostids__ms'),
		new CFormField(
			(new CMultiSelect([
				'name' => 'filter_hostids[]',
				'object_name' => 'hosts',
				'data' => $data['ms']['hosts'],
				'multiple' => true,
				'popup' => [
					'filter_preselect' => [
						'id' => 'filter_groupids_',
						'submit_as' => 'groupid'
					],
					'parameters' => [
						'srctbl' => 'hosts',
						'srcfld1' => 'hostid',
						'dstfrm' => CFilter::FORM_NAME,
						'dstfld1' => 'filter_hostids_'
					]
				]
			]))->setWidth(ZBX_TEXTAREA_FILTER_STANDARD_WIDTH)
		)
	]);

$right = (new CFormGrid())
	->addClass(CFormGrid::ZBX_STYLE_FORM_GRID_LABEL_WIDTH_TRUE)
	->addItem([
		new CLabel(_('Service tags')),
		new CFormField(
			CTagFilterFieldHelper::getTagFilterField([
				'evaltype' => $filter['evaltype'],
				'tags' => $filter['tags'] ?: [['tag' => '', 'value' => '', 'operator' => TAG_OPERATOR_LIKE]]
			])
		)
	])
	->addItem([
		new CLabel(CI18n::any('Group by')),
		new CFormField(
			(new CRadioButtonList('filter_period', (int) $filter['period']))
				->addValue(_('Hour'), CSlaFilter::PERIOD_HOUR)
				->addValue(_('Day'), CSlaFilter::PERIOD_DAY)
				->addValue(_('Week'), CSlaFilter::PERIOD_WEEK)
				->addValue(_('Month'), CSlaFilter::PERIOD_MONTH)
				->addValue(_('Year'), CSlaFilter::PERIOD_YEAR)
				->setModern(true)
		)
	])
	->addItem([
		new CLabel(_('From'), 'filter_date_from'),
		new CFormField(
			(new CDateSelector('filter_date_from', $filter['date_from']))
				->setDateFormat(ZBX_DATE)
				->setPlaceholder(_('YYYY-MM-DD'))
		)
	])
	->addItem([
		new CLabel(_('To'), 'filter_date_to'),
		new CFormField(
			(new CDateSelector('filter_date_to', $filter['date_to']))
				->setDateFormat(ZBX_DATE)
				->setPlaceholder(_('YYYY-MM-DD'))
		)
	]);

$filter_form = (new CFilter())
	->setResetUrl((new CUrl('zabbix.php'))->setArgument('action', 'sladashboard.view'))
	->setProfile(CSlaFilter::PROFILE)
	->setActiveTab($data['active_tab'])
	->addVar('action', 'sladashboard.view')
	->addFilterTab(_('Filter'), [$left, $right]);

if ($web_layout_mode == ZBX_LAYOUT_KIOSKMODE) {
	$filter_form->setHidden();
}

$page = (new CHtmlPage())
	->setTitle(CI18n::t('SLA dashboard'))
	->setWebLayoutMode($web_layout_mode)
	->setControls(
		(new CTag('nav', true, (new CList())->addItem(get_icon('kioskmode', ['mode' => $web_layout_mode]))))
			->setAttribute('aria-label', _('Content controls'))
	)
	->addItem($filter_form);

if ($data['errors']) {
	$page->addItem(makeMessageBox(ZBX_STYLE_MSG_BAD, array_map(static fn($e) => ['message' => $e], $data['errors'])));
}

$page
	->addItem((new CDiv())->setId('sla-dashboard-root')->addClass('sla-dashboard'))
	->show();

(new CTemplateTag('filter-tag-row-tmpl'))
	->addItem(CTagFilterFieldHelper::getTemplate())
	->show();

echo (new CScriptTag(
	'window.SLA_DASHBOARD = '.json_encode($data['bootstrap'],
		JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES
	).';'
));

(new CScriptTag('
	jQuery("#filter-tags")
		.dynamicRows({template: "#filter-tag-row-tmpl"})
		.on("afteradd.dynamicRows", function () {
			const rows = this.querySelectorAll(".form_row");
			new CTagFilterItem(rows[rows.length - 1]);
		});
	document.querySelectorAll("#filter-tags .form_row").forEach((row) => new CTagFilterItem(row));

	// Service: o mesmo popup de serviços do SLA report (o multiselect não tem popup próprio).
	jQuery("#filter_serviceids_").multiSelect("getSelectButton").addEventListener("click", () => {
		const overlay = PopUp("popup.services", {title: '.json_encode(_('Service')).', multiple: 1},
			{dialogueid: "services"}
		);
		overlay.$dialogue[0].addEventListener("dialogue.submit", (e) => {
			jQuery("#filter_serviceids_").multiSelect("addData",
				e.detail.map((s) => ({id: s.serviceid, name: s.name}))
			);
		});
	});
'))
	->setOnDocumentReady()
	->show();

echo (new CTag('script', true))
	->setAttribute('type', 'module')
	->setAttribute('src', $assets.'/js/sla-dashboard.js?v='.$version);
