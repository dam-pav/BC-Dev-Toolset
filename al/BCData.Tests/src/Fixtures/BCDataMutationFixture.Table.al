table 50221 "BCD Mutation Fixture"
{
    DataClassification = CustomerContent;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Name; Code[20]) { }
        field(3; Sequence; Integer) { }
        field(4; Quantity; Decimal)
        {
            InitValue = 1;
            trigger OnValidate()
            begin
                if Quantity < 0 then
                    Error('BCD_GENERIC_QUANTITY_NEGATIVE');
                Amount := Quantity * Price;
                Trace += 'Q';
            end;
        }
        field(5; Price; Decimal)
        {
            InitValue = 2;
            trigger OnValidate()
            begin
                Amount := Quantity * Price;
                Trace += 'P';
            end;
        }
        field(6; Amount; Decimal) { }
        field(7; Trace; Text[100]) { }
        field(8; "Insert Count"; Integer) { }
        field(9; "Modify Count"; Integer) { }
        field(10; Flag; Boolean) { }
        field(11; "Large Integer"; BigInteger) { }
        field(12; Description; Text[100])
        {
            trigger OnValidate()
            begin
                if Description = 'BCD_MOVE_KEY' then
                    Name := 'B';
            end;
        }
        field(13; Identifier; Guid) { }
        field(14; "Date Value"; Date) { }
        field(15; "Time Value"; Time) { }
        field(16; "DateTime Value"; DateTime) { }
        field(17; Choice; Enum "Sales Line Type") { }
        field(18; "Option Value"; Option) { OptionMembers = None,First,Second; }
        field(19; Content; Blob) { }
        field(20; "Sequence Filter"; Integer) { FieldClass = FlowFilter; }
        field(21; "Entry Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("BCD Probe Sum Entry".Amount where("Run ID" = field("Run ID"), "Header Line No." = field("Sequence Filter")));
        }
    }
    keys { key(PK; "Run ID", Name, Sequence) { Clustered = true; } }

    trigger OnInsert()
    begin
        "Insert Count" += 1;
        Trace += 'I';
        Log('I');
    end;

    trigger OnModify()
    begin
        "Modify Count" += 1;
        Trace += 'M';
        Log('M');
    end;

    trigger OnDelete()
    begin
        Log('D');
    end;

    trigger OnRename()
    begin
        Log('R');
    end;

    local procedure Log(Action: Code[1])
    var
        Entry: Record "BCD Mutation Trigger Log";
    begin
        Entry."Event ID" := CreateGuid();
        Entry."Run ID" := "Run ID";
        Entry.Action := Action;
        Entry.Insert();
    end;
}
