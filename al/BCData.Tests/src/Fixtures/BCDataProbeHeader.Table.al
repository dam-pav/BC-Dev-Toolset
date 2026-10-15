table 50200 "BCD Probe Header"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; "Line No."; Integer) { }
        field(3; Quantity; Decimal)
        {
            trigger OnValidate()
            begin
                Amount := Quantity * "Unit Price";
                "Validation Trace" += 'Q';
            end;
        }
        field(4; "Unit Price"; Decimal)
        {
            trigger OnValidate()
            begin
                Amount := Quantity * "Unit Price";
                "Validation Trace" += 'P';
            end;
        }
        field(5; Amount; Decimal) { }
        field(6; "Validation Trace"; Text[20]) { }
        field(7; "Modify Count"; Integer) { }
        field(10; "Bucket Filter"; Integer)
        {
            FieldClass = FlowFilter;
        }
        field(11; "Entry Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("BCD Probe Sum Entry".Amount where("Run ID" = field("Run ID"), "Header Line No." = field("Line No."), Bucket = field("Bucket Filter")));
        }
    }

    keys
    {
        key(PK; "Run ID", "Line No.") { Clustered = true; }
    }

    trigger OnModify()
    begin
        "Modify Count" += 1;
    end;

    trigger OnRename()
    var
        RenameLog: Record "BCD Probe Rename Log";
    begin
        RenameLog.Init();
        RenameLog."Event ID" := CreateGuid();
        RenameLog."Run ID" := "Run ID";
        RenameLog."Old Line No." := xRec."Line No.";
        RenameLog."New Line No." := "Line No.";
        RenameLog.Insert(true);
    end;
}
