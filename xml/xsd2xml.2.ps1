#TODO: determine best way to parse Xml from PS

param (
    [string]$schema,
    [string]$element,
    [string]$template = $null,
    [switch]$use_default_namespaces,
    [switch]$enable_choice,
    [switch]$print_comments
)

# Sample data is hardcoded
function Get-ValsMap {
    $v = @{}
    $v['decimal'] = '10'
    $v['float'] = '-42.217E11'
    $v['double'] = '+24.3e-3'
    $v['integer'] = '176'
    $v['positiveInteger'] = '+3'
    $v['negativeInteger'] = '-7'
    $v['nonPositiveInteger'] = '-34'
    $v['nonNegativeInteger'] = '35'
    $v['long'] = '567'
    $v['int'] = '109'
    $v['short'] = '4'
    $v['byte'] = '2'
    $v['unsignedLong'] = '94'
    $v['unsignedInt'] = '96'
    $v['unsignedShort'] = '24'
    $v['unsignedByte'] = '17'
    $v['dateTime'] = '2020-12-17T09:30:47Z'
    $v['date'] = '2020-04-12'
    $v['gYearMonth'] = '2020-04'
    $v['gYear'] = '2020'
    $v['duration'] = 'P2Y6M5DT12H35M30S'
    $v['dayTimeDuration'] = 'P1DT2H'
    $v['yearMonthDuration'] = 'P2Y6M'
    $v['gMonthDay'] = '--04-12'
    $v['gDay'] = '---02'
    $v['gMonth'] = '--04'
    $v['string'] = 'String'
    $v['normalizedString'] = 'The cure for boredom is curiosity.'
    $v['token'] = 'token'
    $v['language'] = 'en-US'
    $v['NMTOKEN'] = 'A_BCD'
    $v['NMTOKENS'] = 'ABCD 123'
    $v['NCName'] = '_my.Element'
    $v['ID'] = 'IdID'
    $v['IDREFS'] = 'IDrefs'
    $v['ENTITY'] = 'prod557'
    $v['ENTITIES'] = 'prod557 prod563'
    $v['QName'] = 'pre:myElement'
    $v['boolean'] = 'true'
    $v['hexBinary'] = '0FB8'
    $v['base64Binary'] = '0fb8'
    $v['anyURI'] = 'https://mixvel.com/'
    $v['notation'] = 'notation'
    return $v
}

class GenXML {
    [string]$xsd
    [string]$elem
    [string]$template
    [bool]$use_default_schemas
    [bool]$enable_choice
    [bool]$print_comments
    [hashtable]$vals
    [bool]$root

    GenXML([string]$xsd, [string]$elem, [string]$template, [bool]$use_default_schemas, [bool]$enable_choice, [bool]$print_comments) {
        $this.xsd = [xml] (Get-Content $xsd)
        $this.elem = $elem
        $this.template = $template
        $this.use_default_schemas = $use_default_schemas
        $this.enable_choice = $enable_choice
        $this.print_comments = $print_comments
        $this.root = $true
        $this.vals = Get-ValsMap
    }

    [void]ReadTemplate() {
        if (Test-Path $this.template) {
            $config = Get-Content $this.template | ConvertFrom-StringData
            if ($config[$this.elem]) {
                $config[$this.elem].PSObject.Properties | ForEach-Object {
                    $this.vals[$_.Name] = $_.Value
                }
            }
        }
    }

    [string]ShortNs([string]$ns) {
        foreach ($k in $this.xsd.DocumentElement.NamespaceURI) {
            if ($this.xsd.DocumentElement.GetNamespaceOfPrefix($k) -eq $ns) {
                return $k
            }
        }
        return ''
    }

    [string]UseShortNs([string]$name) {
        if ($name.StartsWith('{')) {
            $x = $name.IndexOf('}')
            $ns = $name.Substring(1, $x - 1)
            $short_ns = $this.ShortNs($ns)
            return ($short_ns + ":" + $name.Substring($x + 1)) -replace '^:', ''
        }
        return $name
    }

    [string]RemoveNs([string]$name) {
        if ($name.StartsWith('{')) {
            $x = $name.IndexOf('}')
            return $name.Substring($x + 1)
        }
        return $name
    }

    [void]PrintHeader() {
        Write-Output "<?xml version=`"1.0`" encoding=`"UTF-8`"?>"
    }

    [string]NsMapStr() {
        $ns_all = ''
        $s = if ($this.use_default_schemas) { $this.xsd.DocumentElement.NamespaceURI } else { $DEFAULT_SCHEMAS }
        foreach ($k in $s.Keys) {
            if ($ns_all -notcontains $s[$k]) {
                $prefix = $k
                if ($prefix -notcontains ':' -or $prefix -eq '') {
                    $prefix = 'xmlns' + (':' + $prefix)
                }
                $ns_all += $prefix + '="' + ($s[$k] -f $this.elem) + '" '
            }
        }
        return $ns_all.Trim()
    }

    [string]StartTag([string]$name, [string]$attrs='') {
        $x = '<' + $name
        if ($this.root) {
            $this.root = $false
            $x += ' ' + $this.NsMapStr()
        }
        if ($attrs) {
            $x += ' ' + $attrs
        }
        $x += '>'
        return $x
    }

    [string]EndTag([string]$name) {
        return '</' + $name + '>'
    }

    [string]GenVal([string]$name) {
        $name = $this.RemoveNs($name)
        if ($this.vals.ContainsKey($name)) {
            return $this.vals[$name]
        }
        return 'UNKNOWN'
    }

    [string]GenAttrs($attributes) {
        $a_all = ''
        foreach ($attr in $attributes.Keys) {
            $tp = $attributes[$attr].type.name
            $a_all += $attr + '="' + $this.GenVal($tp) + '" '
        }
        return $a_all.Trim()
    }

    [void]Group2XML($g) {
        $model = $this.RemoveNs([string]$g.model)
        $nextg = $g._group
        $y = $nextg.Count
        if ($y -eq 0) {
            $this.PrintComment('empty')
            return
        }

        $this.PrintComment("START:[$model]")
        if ($this.enable_choice -and $model -eq 'choice') {
            $this.PrintComment("next item is from a [choice] group with size=$y")
        } else {
            $this.PrintComment("next $y items are in a [$model] group")
        }

        foreach ($ng in $nextg) {
            if ($ng -is [xmlschema.validators.XsdElement]) {
                $this.Node2XML($ng)
            } elseif ($ng -is [xmlschema.validators.XsdAnyElement]) {
                $this.Node2XML($ng)
            } else {
                $this.Group2XML($ng)
            }

            if ($this.enable_choice -and $model -eq 'choice') {
                break
            }
        }
        $this.PrintComment("END:[$model]")
    }

    [void]Node2XML($node) {
        if ([int]$node.min_occurs -eq 0) {
            $this.PrintComment("next 1 item is optional (minOccurs = 0)")
        }
        if ([int]$node.max_occurs -gt 1) {
            $this.PrintComment("next 1 item is multiple (maxOccurs > 1)")
        }

        if ($node -is [xmlschema.validators.XsdAnyElement]) {
            Write-Output '<_ANY_/>'
            return
        }

        if ($node.type -is [xmlschema.validators.XsdComplexType]) {
            $n = $this.UseShortNs($node.name)
            if ($node.type.is_simple()) {
                $this.PrintComment("simple content")
                $tp = [string]$node.type.content_type
                Write-Output ($this.StartTag($n) + $this.GenVal($tp) + $this.EndTag($n))
            } elseif (-not ($node.type.content_type -is [xmlschema.validators.XsdGroup])) {
                $this.PrintComment("complex content")
                $attrs = $this.GenAttrs($node.attributes)
                $tp = $node.type.content_type.name
                Write-Output ($this.StartTag($n, $attrs) + $this.GenVal($tp) + $this.EndTag($n))
            } else {
                $this.PrintComment("complex content")
                Write-Output ($this.StartTag($n))
                $this.Group2XML($node.type.content_type)
                Write-Output ($this.EndTag($n))
            }
        } elseif ($node.type -is [xmlschema.validators.XsdAtomicBuiltin]) {
            $n = $this.UseShortNs($node.name)
            $tp = [string]$node.type
            Write-Output ($this.StartTag($n) + $this.GenVal($tp) + $this.EndTag($n))
        } elseif ($node.type -is [xmlschema.validators.XsdSimpleType]) {
            $n = $this.UseShortNs($node.name)
            if ($node.type -is [xmlschema.validators.XsdList]) {
                $this.PrintComment("simpletype: list")
                $tp = [string]$node.type.item_type
                Write-Output ($this.StartTag($n) + $this.GenVal($tp) + $this.EndTag($n))
            } elseif ($node.type -is [xmlschema.validators.XsdUnion]) {
                $this.PrintComment("simpletype: union.")
                $this.PrintComment("default: using the 1st type")
                $tp = [string]$node.type.member_types[0].base_type
                Write-Output ($this.StartTag($n) + $this.GenVal($tp) + $this.EndTag($n))
            } else {
                $tp = $node.type.base_type.name
                $value = $this.GenVal($n)
                if ($value -eq 'UNKNOWN') {
                    $value = $this.GenVal($tp)
                }
                Write-Output ($this.StartTag($n) + $value + $this.EndTag($n))
            }
        } else {
            Write-Output "ERROR: unknown type: $($node.type)"
        }
    }

    [void]PrintComment([string]$comment) {
        if ($this.print_comments) {
            Write-Output "<!--$comment-->"
        }
    }

    [void]Run() {
        $this.vals = Get-ValsMap
        if ($this.template) {
            $this.ReadTemplate()
        }
        $this.PrintHeader()
        $this.Node2XML($this.xsd.SelectSingleNode("//xsd:element[@name='$this.elem']"))
    }
}

function Main {
    param (
        [string]$schema,
        [string]$element,
        [string]$template = $null,
        [switch]$use_default_namespaces,
        [switch]$enable_choice,
        [switch]$print_comments
    )

    $generator = [GenXML]::new($schema, $element, $template, $use_default_namespaces.IsPresent, $enable_choice.IsPresent, $print_comments.IsPresent)
    $generator.Run()
}

Main -schema $schema -element $element -template $template -use_default_namespaces:$use_default_namespaces -enable_choice:$enable_choice -print_comments:$print_comments
